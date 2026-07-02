import { describe, expect, it } from 'vitest';
import { renderLlamaServerUnit } from './backend-config';

describe('renderLlamaServerUnit', () => {
  it('renders a unit matching the shape of the real llama-ornith.service unit', () => {
    const unit = renderLlamaServerUnit({
      alias: 'maxwell1500/ornith-35b:IQ3_M',
      weightsPath: '/usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee0',
      host: '127.0.0.1',
      port: 11436,
      parallelSlots: 2,
      ctxTotal: 180224,
      kvCacheType: 'q8_0',
      flashAttn: true,
      logPath: '/home/marsh-office/.papercusp/provisioner-ornith.log',
    });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('ExecStart=llama-server');
    expect(unit).toContain('-m /usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee0');
    expect(unit).toContain('--host 127.0.0.1 --port 11436');
    expect(unit).toContain('--flash-attn on');
    expect(unit).toContain('-np 2 -c 180224');
    expect(unit).toContain('--cache-type-k q8_0 --cache-type-v q8_0');
    expect(unit).toContain('--alias maxwell1500/ornith-35b:IQ3_M');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('honors flashAttn:false and a custom binPath', () => {
    const unit = renderLlamaServerUnit({
      alias: 'x',
      weightsPath: '/w',
      host: '0.0.0.0',
      port: 8080,
      parallelSlots: 1,
      ctxTotal: 4096,
      kvCacheType: 'f16',
      flashAttn: false,
      logPath: '/log',
      binPath: '/opt/llama.cpp/bin/llama-server',
    });
    expect(unit).toContain('--flash-attn off');
    expect(unit).toContain('ExecStart=/opt/llama.cpp/bin/llama-server');
  });
});
