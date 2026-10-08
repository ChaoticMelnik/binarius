import { BrokerRestErrorCode, decimalStringSchema } from '@binarius/shared';
import { describe, expect, it } from 'vitest';
import { BrokerSocketState } from '../broker/socket';
import {
  compareDecimal,
  PHASE_SENDER,
  PROBE_PHASES,
  PROBE_SOCKETS,
  renderVerdict,
  verdict,
  type HeardAnswers,
  type Phase,
  type ProbeSocket,
  type ProbeVerdict,
  type VerdictInput,
} from './socket-probe-verdict';

const heard = (openTradeSuccess: number, openTradeFail: number): HeardAnswers => ({
  openTradeSuccess,
  openTradeFail,
});
const SILENT = heard(0, 0);

// every condition of the safe verdict met: each command answered as expected and heard by its
// sender only, the REST order opened and heard by nobody, both sockets on one ready connection,
// every window completed
function safeInput(): VerdictInput {
  return {
    userDataVerified: { A: true, B: true },
    phases: {
      a_min: { command: 'success', heard: { A: heard(1, 0), B: SILENT }, windowCompleted: true },
      a_below: { command: 'fail', heard: { A: heard(0, 1), B: SILENT }, windowCompleted: true },
      b_min: { command: 'success', heard: { A: SILENT, B: heard(1, 0) }, windowCompleted: true },
      b_below: { command: 'fail', heard: { A: SILENT, B: heard(0, 1) }, windowCompleted: true },
      rest_min: { command: 'success', heard: { A: SILENT, B: SILENT }, windowCompleted: true },
    },
    sockets: {
      A: {
        state: BrokerSocketState.Ready,
        connectionsBefore: 1,
        connectionsAfter: 1,
        leftReady: [],
      },
      B: {
        state: BrokerSocketState.Ready,
        connectionsBefore: 1,
        connectionsAfter: 1,
        leftReady: [],
      },
    },
  };
}

const changed = (change: (input: VerdictInput) => void): VerdictInput => {
  const input = safeInput();
  change(input);
  return input;
};

const SOCKET_PHASES = PROBE_PHASES.filter((phase) => PHASE_SENDER[phase] !== 'rest');
const MIN_PHASES = ['a_min', 'b_min'] as const;
const BELOW_PHASES = ['a_below', 'b_below'] as const;
const senderOf = (phase: Phase) => PHASE_SENDER[phase] as ProbeSocket;
const NOT_READY_STATES = Object.values(BrokerSocketState).filter(
  (state) => state !== BrokerSocketState.Ready,
);

describe('verdict', () => {
  it('is sender_only, with the safe line, only when every condition holds', () => {
    const result = verdict(safeInput());
    expect(result).toEqual({ kind: 'sender_only' });
    expect(renderVerdict(result)).toBe(
      'verdict: no cross-socket answer within the window; BROKER_WS_URL may be set',
    );
  });

  // one condition broken per row, every other one met: the row names the one reason
  const singleViolations: [string, VerdictInput, string][] = [
    ...PROBE_SOCKETS.map((socket): [string, VerdictInput, string] => [
      `user.data on ${socket} not verified`,
      changed((input) => {
        input.userDataVerified[socket] = false;
      }),
      `user.data on ${socket} did not match the account before command 1`,
    ]),
    ...SOCKET_PHASES.flatMap((phase): [string, VerdictInput, string][] => {
      const expected = phase.endsWith('_min') ? 'success' : 'fail';
      const outcome = (
        command: VerdictInput['phases'][Phase]['command'],
        detail?: string,
      ): VerdictInput =>
        changed((input) => {
          input.phases[phase].command = command;
          if (detail !== undefined) input.phases[phase].detail = detail;
        });
      return [
        [
          `${phase} unknown (state_changed)`,
          outcome('unknown', 'state_changed, reconnecting'),
          `${phase}: expected ${expected}, got unknown (state_changed, reconnecting)`,
        ],
        [
          `${phase} unknown (aborted)`,
          outcome('unknown', 'aborted, ready'),
          `${phase}: expected ${expected}, got unknown (aborted, ready)`,
        ],
        [
          `${phase} not_sent (not_ready)`,
          outcome('not_sent', 'not_ready, reconnecting'),
          `${phase}: expected ${expected}, got not_sent (not_ready, reconnecting)`,
        ],
        [
          `${phase} not_sent (aborted)`,
          outcome('not_sent', 'aborted, ready'),
          `${phase}: expected ${expected}, got not_sent (aborted, ready)`,
        ],
        [`${phase} not_run`, outcome('not_run'), `${phase}: not run`],
        expected === 'success'
          ? [
              `${phase} fail instead of success`,
              outcome('fail'),
              `${phase}: expected success, got fail`,
            ]
          : [
              `${phase} success instead of fail`,
              outcome('success'),
              `${phase}: expected fail, got success`,
            ],
      ];
    }),
    ...BELOW_PHASES.map((phase): [string, VerdictInput, string] => [
      `${phase} skipped`,
      changed((input) => {
        input.phases[phase].command = 'skipped';
      }),
      `${phase}: skipped, min_trade_amount <= 0.01`,
    ]),
    ...(
      [
        [BrokerRestErrorCode.Unauthorized, 'the token was refused'],
        [BrokerRestErrorCode.RateLimited, 'rate limited'],
        [BrokerRestErrorCode.Rejected, 'the broker refused the order'],
        [BrokerRestErrorCode.Unavailable, 'no answer, the order may be open'],
        [
          BrokerRestErrorCode.ContractViolation,
          'the answer failed the schema, the order may be open',
        ],
        [BrokerRestErrorCode.Aborted, 'aborted, the order may be open'],
      ] as const
    ).map(([code, why]): [string, VerdictInput, string] => [
      `rest_min ${code}`,
      changed((input) => {
        input.phases.rest_min.command = code;
      }),
      `rest_min: expected success, got ${code} (${why})`,
    ]),
    [
      'rest_min threw',
      changed((input) => {
        input.phases.rest_min.command = 'threw';
      }),
      'rest_min: expected success, got threw',
    ],
    [
      'rest_min not_run',
      changed((input) => {
        input.phases.rest_min.command = 'not_run';
      }),
      'rest_min: not run',
    ],
    ...MIN_PHASES.map((phase): [string, VerdictInput, string] => [
      `${phase}: the sender heard no success`,
      changed((input) => {
        input.phases[phase].heard[senderOf(phase)].openTradeSuccess = 0;
      }),
      `${phase}: ${senderOf(phase)} heard no open_trade_success`,
    ]),
    ...BELOW_PHASES.map((phase): [string, VerdictInput, string] => [
      `${phase}: the sender heard no fail`,
      changed((input) => {
        input.phases[phase].heard[senderOf(phase)].openTradeFail = 0;
      }),
      `${phase}: ${senderOf(phase)} heard no open_trade_fail`,
    ]),
    ...PROBE_SOCKETS.flatMap((socket): [string, VerdictInput, string][] => [
      ...NOT_READY_STATES.map((state): [string, VerdictInput, string] => [
        `${socket} ${state} at the verdict`,
        changed((input) => {
          input.sockets[socket].state = state;
        }),
        `${socket} was not connected throughout (state ${state})`,
      ]),
      [
        `${socket} connections changed`,
        changed((input) => {
          input.sockets[socket].connectionsAfter = 2;
        }),
        `${socket} was not connected throughout (connections 1 -> 2)`,
      ],
      [
        `${socket} left ready`,
        changed((input) => {
          input.sockets[socket].leftReady = ['ready -> reconnecting (transport close)'];
        }),
        `${socket} was not connected throughout (ready -> reconnecting (transport close))`,
      ],
    ]),
    ...PROBE_PHASES.map((phase): [string, VerdictInput, string] => [
      `${phase}: the window did not complete`,
      changed((input) => {
        input.phases[phase].windowCompleted = false;
      }),
      `${phase}: the window did not complete`,
    ]),
  ];

  it.each(singleViolations)('inconclusive: %s', (_name, input, reason) => {
    const result = verdict(input);
    expect(result).toEqual({ kind: 'inconclusive', missing: [reason] });
    expect(renderVerdict(result)).toBe(
      `verdict: inconclusive: ${reason}; keep BROKER_WS_URL unset`,
    );
  });

  // a socket that did not send the phase's command hears one answer; every other condition met
  const crossSocket = PROBE_PHASES.flatMap((phase) =>
    PROBE_SOCKETS.filter((socket) => socket !== PHASE_SENDER[phase]).flatMap((socket) =>
      (
        [
          ['success', heard(1, 0)],
          ['fail', heard(0, 1)],
        ] as const
      ).map(([kind, answers]): [string, Phase, ProbeSocket, HeardAnswers] => [
        `${phase}: ${socket} heard a ${kind}`,
        phase,
        socket,
        answers,
      ]),
    ),
  );

  it.each(crossSocket)('broadcast: %s', (_name, phase, socket, answers) => {
    const result = verdict(
      changed((input) => {
        input.phases[phase].heard[socket] = { ...answers };
      }),
    );
    expect(result).toEqual({ kind: 'broadcast', heard: [{ phase, socket, answers }] });
    expect(renderVerdict(result)).toBe(
      `verdict: the broker sends answers to another socket (${phase}: ${socket} heard ` +
        `success=${answers.openTradeSuccess} fail=${answers.openTradeFail}); keep BROKER_WS_URL unset`,
    );
  });

  // realistic runs from the review rounds of #282 and the Codex recheck: extra coverage, several
  // conditions at once, no claim that a row discriminates one predicate
  describe('composite runs', () => {
    const reconnected = (input: VerdictInput, socket: ProbeSocket) => {
      input.sockets[socket].leftReady = ['ready -> reconnecting (transport close)'];
      input.sockets[socket].connectionsAfter = 2;
    };

    it('command 1 timed out (A tainted) and command 2 was not sent', () => {
      const result = verdict(
        changed((input) => {
          input.phases.a_min = {
            command: 'unknown',
            detail: 'aborted, ready',
            heard: { A: SILENT, B: SILENT },
            windowCompleted: true,
          };
          input.phases.a_below = {
            command: 'not_sent',
            detail: 'not_ready, reconnecting',
            heard: { A: SILENT, B: SILENT },
            windowCompleted: true,
          };
          input.sockets.A.state = BrokerSocketState.Reconnecting;
          input.sockets.A.leftReady = ['ready -> reconnecting (command aborted)'];
        }),
      );
      expect(result).toEqual({
        kind: 'inconclusive',
        missing: [
          'a_min: expected success, got unknown (aborted, ready)',
          'a_min: A heard no open_trade_success',
          'a_below: expected fail, got not_sent (not_ready, reconnecting)',
          'a_below: A heard no open_trade_fail',
          'A was not connected throughout (state reconnecting; ready -> reconnecting (command aborted))',
        ],
      });
    });

    it('B reconnecting with connections 2', () => {
      const result = verdict(
        changed((input) => {
          input.sockets.B.state = BrokerSocketState.Reconnecting;
          input.sockets.B.connectionsAfter = 2;
        }),
      );
      expect(result.kind).toBe('inconclusive');
    });

    it('B disconnected by the server', () => {
      const result = verdict(
        changed((input) => {
          input.sockets.B.state = BrokerSocketState.DisconnectedByServer;
          input.sockets.B.leftReady = ['ready -> disconnected_by_server (io server disconnect)'];
        }),
      );
      expect(result.kind).toBe('inconclusive');
    });

    it('A reconnected between commands and is ready again', () => {
      const result = verdict(changed((input) => reconnected(input, 'A')));
      expect(result).toEqual({
        kind: 'inconclusive',
        missing: [
          'A was not connected throughout (connections 1 -> 2; ready -> reconnecting (transport close))',
        ],
      });
    });

    it('B heard a success and reconnected: broadcast wins', () => {
      const result = verdict(
        changed((input) => {
          input.phases.a_min.heard.B = heard(1, 0);
          reconnected(input, 'B');
        }),
      );
      expect(result).toEqual({
        kind: 'broadcast',
        heard: [{ phase: 'a_min', socket: 'B', answers: heard(1, 0) }],
      });
    });

    it('the broker answers the oldest socket: A hears the answers to B', () => {
      const result = verdict(
        changed((input) => {
          input.phases.b_min.heard = { A: heard(1, 0), B: SILENT };
          input.phases.b_below.heard = { A: heard(0, 1), B: SILENT };
        }),
      );
      expect(result).toEqual({
        kind: 'broadcast',
        heard: [
          { phase: 'b_min', socket: 'A', answers: heard(1, 0) },
          { phase: 'b_below', socket: 'A', answers: heard(0, 1) },
        ],
      });
    });

    it('the REST order is echoed to both sockets', () => {
      const result: ProbeVerdict = verdict(
        changed((input) => {
          input.phases.rest_min.heard = { A: heard(1, 0), B: heard(1, 0) };
        }),
      );
      expect(renderVerdict(result)).toBe(
        'verdict: the broker sends answers to another socket (rest_min: A heard success=1 fail=0; ' +
          'rest_min: B heard success=1 fail=0); keep BROKER_WS_URL unset',
      );
    });
  });
});

describe('compareDecimal', () => {
  const d = (value: string) => decimalStringSchema.parse(value);

  it.each<[string, string, -1 | 0 | 1]>([
    ['0.015', '0.01', 1],
    ['0.010', '0.01', 0],
    ['1', '0.01', 1],
    ['0.005', '0.01', -1],
    ['10.00000000', '10', 0],
    // equal as doubles: only the exact comparison tells them apart
    ['0.10000000000000001', '0.1', 1],
  ])('%s against %s is %i', (a, b, order) => {
    expect(compareDecimal(d(a), d(b))).toBe(order);
  });
});
