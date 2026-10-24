"""Run a NEW retained-corpus edition inside source-preview verifier + with-test-pg.

The plan is an immutable JSON file with pinned consumption/schema/query/configuration
receipts and expected table counts. Runtime instrumentation and timing use distinct
outputs. This driver never resumes, overwrites, or extends an earlier edition.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit, urlunsplit


def fingerprint(file):
    file = Path(file)
    before = file.stat()
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(block)
    after = file.stat()
    stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    if stamp(before) != stamp(after):
        raise ValueError('input changed during hashing: ' + str(file))
    return {'path': str(file), 'sha256': digest.hexdigest(), 'bytes': after.st_size}


def pinned(pin):
    actual = fingerprint(pin['path'])
    if actual['sha256'] != pin['sha256']:
        raise ValueError('input pin differs: ' + pin['path'])
    return json.loads(Path(pin['path']).read_bytes())


def validate_plan(plan):
    if plan.get('schemaVersion') != 1 or not plan.get('workItemId') or not plan.get('expectedCounts'):
        raise ValueError('missing edition identity or expected corpus population')
    for key in ['consumption', 'schema', 'queries', 'configuration']:
        if not plan.get(key, {}).get('path') or len(plan.get(key, {}).get('sha256', '')) != 64:
            raise ValueError('missing input pin: ' + key)
    if any(not table.replace('_', '').isalnum() or not isinstance(count, int) or count < 0
           for table, count in plan['expectedCounts'].items()):
        raise ValueError('invalid expected table population')
    destination = Path(plan['outputDirectory'])
    if not destination.is_absolute() or destination.exists():
        raise ValueError('edition requires a new absolute output directory')


def run(plan_path):
    plan = json.loads(Path(plan_path).read_bytes())
    validate_plan(plan)
    repo = Path.cwd().resolve()
    if not (repo / '.verifier-source.json').is_file():
        raise ValueError('requires maintained immutable source verifier')
    admin = os.environ['PAPERCUSP_TEST_PG_ADMIN_URL']
    endpoint = urlsplit(admin)
    if endpoint.hostname not in ('127.0.0.1', 'localhost', '::1') or not endpoint.port or endpoint.port == 5432:
        raise ValueError('requires disposable loopback PostgreSQL')
    for key, value in {'PAPERCUSP_MEMORY_EMBEDDER': 'gemma', 'PAPERCUSP_EMBED_DEVICE': 'cpu',
                       'PAPERCUSP_TRANSFORMERS_LOCAL_ONLY': '1', 'PAPERCUSP_SKIP_PG_DISCOVERY': '1'}.items():
        if os.environ.get(key) != value:
            raise ValueError('missing explicit policy: ' + key)
    destination = Path(plan['outputDirectory'])
    destination.mkdir(mode=0o700)
    started = time.monotonic()
    receipt = {'schemaVersion': 1, 'kind': 'new-retained-search-baseline-edition',
               'workItemId': plan['workItemId'], 'plan': fingerprint(plan_path), 'phases': [], 'commands': [],
               'baselineAccepted': False, 'completeRuntimeClosureVerified': False}

    def phase(name, **fields):
        row = {'phase': name, 'elapsedSec': round(time.monotonic() - started, 3), **fields}
        receipt['phases'].append(row)
        with (destination / 'phases.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        print(json.dumps(row), flush=True)

    def sql(statement, database=admin):
        result = subprocess.run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database],
                                input=statement, text=True, capture_output=True, timeout=14400)
        if result.returncode:
            raise RuntimeError('private SQL: ' + result.stderr.replace(database, '<private-db>')[-2000:])
        return result.stdout.strip()

    def command(label, arguments, env=None, accepted=(0,)):
        phase(label + '-start')
        log = destination / (label + '.log')
        with log.open('xb') as stream:
            result = subprocess.run(arguments, stdout=stream, stderr=subprocess.STDOUT, env=env, timeout=14400)
        receipt['commands'].append({'phase': label, 'exitCode': result.returncode, 'log': fingerprint(log)})
        phase(label + '-end', exitCode=result.returncode)
        if result.returncode not in accepted:
            raise RuntimeError(label + ' failed; see retained private log')
        return result.returncode

    try:
        phase('input-preflight')
        consumption = pinned(plan['consumption'])
        schema = pinned(plan['schema'])
        queries = pinned(plan['queries'])
        pinned(plan['configuration'])
        if queries['configuration']['queryEmbeddingProfile'] != {'mode': 'gemma', 'profileId': 'gemma-embeddinggemma-300m-768@v1'}:
            raise ValueError('exact Gemma query profile required')
        if set(plan['expectedCounts']) != {t for a in schema['archives'] for t in a['tables']}:
            raise ValueError('expected table population differs from selected archive ownership')
        receipt['retainedInputs'] = []
        for row in consumption['files']:
            actual = fingerprint(row['path'])
            if actual['sha256'] != row['sha256'] or actual['bytes'] != row['bytes']:
                raise ValueError('retained input differs: ' + row['path'])
            receipt['retainedInputs'].append(actual)
        # Install preserved model files before expensive restoration. Never use a
        # network download or substitute embedding function to repair a missing model.
        package = (repo / 'node_modules/@huggingface/transformers').resolve(strict=True)
        if not package.is_relative_to(repo):
            raise ValueError('model cache must be inside isolated dependency tree')
        cache = package / '.cache/onnx-community/embeddinggemma-300m-ONNX'
        assets = []
        for row in consumption['files']:
            if row['kind'] != 'model':
                continue
            target = cache / row['relativePath']
            if not target.resolve().is_relative_to(cache) or target.exists():
                raise ValueError('model destination is unsafe or already exists')
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(row['path'], 'rb') as source, target.open('xb') as sink:
                shutil.copyfileobj(source, sink, 8 * 1024 * 1024)
            actual = fingerprint(target)
            if actual['sha256'] != row['sha256'] or actual['bytes'] != row['bytes']:
                raise ValueError('installed model differs')
            assets.append(actual)
        assets_path = destination / 'installed-model-assets.json'
        assets_path.write_text(json.dumps({'assets': assets}, indent=2) + '\n')
        receipt['installedModel'] = fingerprint(assets_path)
        data_directory = Path(sql("SELECT current_setting('data_directory')")).resolve()
        if not data_directory.name.startswith('papercusp-test-pg-'):
            raise ValueError('PostgreSQL is not maintained disposable cluster')
        target_db = 'search_baseline_' + hashlib.sha256(str(destination).encode()).hexdigest()[:16]
        sql('CREATE DATABASE ' + target_db + ' TEMPLATE template0;')
        database = urlunsplit((endpoint.scheme, endpoint.netloc, '/' + target_db, '', ''))
        env = dict(os.environ, PAPERCUSP_TEST_PG_ADMIN_URL=database,
                   HARNESS_ADMIN_DATABASE_URL=database, HARNESS_DATABASE_URL=database,
                   PAPERCUSP_WORKSPACE_ID=queries['workspaceId'])
        command('schema-preflight', ['python3', str(Path(__file__).with_name('prepare-selected-corpus.py')),
                                    '--manifest', plan['schema']['path'], '--receipt', str(destination / 'schema.json')], env)
        for number, archive in enumerate(schema['archives']):
            command('restore-data-' + str(number), ['pg_restore', '--dbname=' + database, '--data-only', '--no-owner',
                    '--no-acl', '--exit-on-error', '--schema=' + schema['schema'],
                    *['--table=' + t for t in archive['tables']], archive['path']])
        receipt['counts'] = {}
        for table, expected in plan['expectedCounts'].items():
            actual = int(sql('SELECT count(*) FROM ' + schema['schema'] + '.' + table, database))
            receipt['counts'][table] = actual
            if actual != expected:
                raise ValueError('restored table count differs: ' + table)
        for number, index in enumerate(schema['indexes']):
            phase('index-start', number=number, index=index['indexname'])
            sql(index['indexdef'].rstrip(';') + ';', database)
            phase('index-end', number=number, index=index['indexname'])
        actual = json.loads(sql("SELECT coalesce(json_agg(row_to_json(i) ORDER BY tablename,indexname),'[]') FROM "
            "(SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='" + schema['schema'] + "') i", database))
        if actual != sorted(schema['indexes'], key=lambda i: (i['tablename'], i['indexname'])):
            raise ValueError('restored index definition population differs')
        if sql("SELECT count(*) FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='" + schema['schema'] + "' AND (NOT x.indisvalid OR NOT x.indisready)", database) != '0':
            raise ValueError('restored index readiness differs')
        receipt['indexes'] = actual
        sql('ANALYZE;', database)
        common = ['--inputs-from', plan['queries']['path'], '--pairs', str(queries['pairsPerSource']),
                  '--sources', ','.join(queries['sources']), '--seed', queries['seed']]
        command('runtime', ['node', '--import', 'tsx', 'packages/operator-core/lib/memory/bench/runtime-qualification-cli.ts',
                '--output', str(destination / 'runtime'), '--assets', str(assets_path),
                '--configuration', plan['configuration']['path'], '--benchmark', '--',
                *common, '--out', str(destination / 'runtime-benchmark.json')], env)
        runtime = json.loads((destination / 'runtime.report.json').read_bytes())
        if not runtime.get('qualifiedComponentsOnly') or not runtime.get('searchAdapterExercised'):
            raise ValueError('actual benchmark runtime did not qualify')
        code = command('timing', ['node', '--import', 'tsx', 'packages/operator-core/lib/search/bench/bm25-hybrid-recall-cli.ts',
                       *common, '--out', str(destination / 'timing-benchmark.json')], env, accepted=(0, 1))
        timing = json.loads((destination / 'timing-benchmark.json').read_bytes())
        if timing.get('sourceQualification', {}).get('verdict') != 'pass':
            raise ValueError('timing source did not qualify')
        receipt['measurement'] = {'exitCode': code, 'verdict': timing['verdict'], 'latencyVerdict': timing['latencyVerdict']}
        for pin in receipt['retainedInputs'] + assets:
            if fingerprint(pin['path']) != pin:
                raise ValueError('input moved during run: ' + pin['path'])
        receipt['artifacts'] = [fingerprint(p) for p in sorted(destination.iterdir()) if p.is_file()]
        phase('measured-contributing-baseline')
    except Exception as error:
        receipt['failure'] = {'type': type(error).__name__, 'message': str(error).replace(admin, '<private-db>')}
        phase('failed', errorType=type(error).__name__)
    finally:
        receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with (destination / 'receipt.json').open('x') as stream:
            json.dump(receipt, stream, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    return 1 if 'failure' in receipt else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True)
    sys.exit(run(parser.parse_args().plan))
