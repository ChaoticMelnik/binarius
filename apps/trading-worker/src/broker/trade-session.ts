import type { BrokerSocketClient } from './socket';

export type TradeSession = Pick<BrokerSocketClient, 'state' | 'openTrade'>;

export interface TradeSessionSource {
  // the live client for the account, or undefined when the worker holds none
  sessionFor(brokerAccountId: string): TradeSession | undefined;
}

// without BROKER_WS_URL there is no session manager: no account has a socket, so every intent
// goes over REST
export const noTradeSessions: TradeSessionSource = { sessionFor: () => undefined };
