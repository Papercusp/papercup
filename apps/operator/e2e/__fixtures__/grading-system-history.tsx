import { createRoot } from 'react-dom/client';
import RubricDetailPanel from '../../app/_components/RubricDetailPanel';

createRoot(document.getElementById('root')!).render(<main>
  <p role="note">Controlled history fixture</p>
  <RubricDetailPanel rubricId="grading-history-browser" />
</main>);
