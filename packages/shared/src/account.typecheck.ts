// Compiled by `tsc -b` (include: src) and imported by nothing: the directives below are the
// oracle that `id` exists on the pending member of LinkedAccountView only. If either line starts
// compiling, tsc reports TS2578 (unused directive) and `pnpm check` fails.
import { isPendingLink, type LinkedAccountView } from './account';
import { BrokerAccountStatus } from './oauth';
import type { PendingBrokerAccountView } from './users';

declare const account: LinkedAccountView;
declare const accounts: readonly LinkedAccountView[];

// @ts-expect-error the union carries no id outside its pending member (TS2339)
export const anyId: string = account.id;
export const activeId: LinkedAccountView = {
  status: BrokerAccountStatus.Active,
  email: null,
  // @ts-expect-error an active member has no id either (TS2353)
  id: 'x',
};
export const pendingId: string | undefined = isPendingLink(account) ? account.id : undefined;
// what the confirm keyboard takes, fed from the /account list without a cast
export const confirmable: readonly PendingBrokerAccountView[] = accounts.filter(isPendingLink);
