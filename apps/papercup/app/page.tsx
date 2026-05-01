import HomeClient from './HomeClient';
import summary from '../public/data/summary.json';
import organization from '../public/data/organization.json';
import harnesses from '../public/data/harnesses.json';

export default function PapercupRoot() {
  return (
    <HomeClient
      summary={summary as any}
      organization={organization as any}
      harnesses={harnesses as any}
    />
  );
}
