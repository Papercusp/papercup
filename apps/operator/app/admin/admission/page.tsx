import AdminShell from "../_components/AdminShell";
import AdmissionRunsClient from "./AdmissionRunsClient";
import ChatBugsHealth from "./ChatBugsHealth";
import TicketSourcesHealth from "./TicketSourcesHealth";

/** Owner-facing work-item admission run ledger, queue-health rollups, ticket-source health and Slack bug reports. */
export default function AdminAdmissionPage() {
  return (
    <AdminShell title="Admission">
      <AdmissionRunsClient />
      <TicketSourcesHealth />
      <ChatBugsHealth />
    </AdminShell>
  );
}
