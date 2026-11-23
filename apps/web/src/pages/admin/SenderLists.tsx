import { Card, CardBody, PageHeader } from '@forge/ui';
import { SenderLists } from '../../components/SenderLists';
import { useCan } from '../../lib/hooks';

export function SenderListsPage() {
  const canManage = useCan('org:manage');
  return (
    <div>
      <PageHeader
        title="Blocked and allowed senders"
        description="Organisation-wide lists of email addresses and domains. They apply to mail from outside the organisation. People can also keep their own lists in Mail settings; a person's block list overrides the organisation's allow list for their mailbox."
      />
      <Card>
        <CardBody>
          <SenderLists base="/api/v1/admin/sender-lists" scope="organisation" canEdit={canManage} />
        </CardBody>
      </Card>
    </div>
  );
}
