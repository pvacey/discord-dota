import { describe, it, expect, mock } from 'bun:test';
import { createGsiHandler, type GsiDeps } from '../src/gsi';
import type { GameEventContext, MappingEntry, SoundPlayer } from '../src/types';

const defaultContext: GameEventContext = {
  accountID: 123,
  matchID: 456,
  gameTime: 100,
  timestamp: Date.now(),
};

function createMockDeps(overrides: Partial<GsiDeps> = {}): GsiDeps {
  return {
    getMapping: mock(() => [] as MappingEntry[]),
    getConnections: mock(() => ({}) as Record<string, SoundPlayer>),
    getClient: mock(() => ({}) as any),
    logEvent: mock(async () => {}),
    ...overrides,
  };
}

// ─── recursiveDiff ───────────────────────────────────────────────

describe('recursiveDiff', () => {
  it('handles flat object diff', () => {
    const playSound = mock(() => {});
    const deps = createMockDeps({
      getMapping: () => [{ event: 'player.kills', sound: 'kill.mp3', condition: '*', value: 0 }],
      getConnections: () => ({ ch1: { playSound } }),
    });
    const gsi = createGsiHandler(deps);

    gsi.recursiveDiff(
      'player.',
      { kills: 3 }, // changed (previously)
      { kills: 5 }, // body (current)
      defaultContext,
    );

    // handleGameEvent should have been called with the current value from body (5), not changed (3)
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith('kill.mp3');
  });

  it('handles nested object diff', () => {
    const logEvent = mock(async () => {});
    const deps = createMockDeps({ logEvent });
    const gsi = createGsiHandler(deps);

    gsi.recursiveDiff(
      '',
      { player: { kills: 2 } },
      { player: { kills: 4 } },
      defaultContext,
    );

    expect(logEvent).toHaveBeenCalledTimes(1);
    // first arg: accountID, fifth arg: eventName
    expect((logEvent.mock.calls[0] as any)[4]).toBe('player.kills');
    // sixth arg: value (current from body)
    expect((logEvent.mock.calls[0] as any)[5]).toBe(4);
  });

  it('skips keys where body[key] is null', () => {
    const logEvent = mock(async () => {});
    const deps = createMockDeps({ logEvent });
    const gsi = createGsiHandler(deps);

    gsi.recursiveDiff(
      'player.',
      { kills: 2 },
      { kills: null } as any,
      defaultContext,
    );

    expect(logEvent).not.toHaveBeenCalled();
  });

  it('skips keys where body[key] is undefined', () => {
    const logEvent = mock(async () => {});
    const deps = createMockDeps({ logEvent });
    const gsi = createGsiHandler(deps);

    gsi.recursiveDiff(
      'player.',
      { kills: 2 },
      {},
      defaultContext,
    );

    expect(logEvent).not.toHaveBeenCalled();
  });

  it('skips nested objects when body[key] is null', () => {
    const logEvent = mock(async () => {});
    const deps = createMockDeps({ logEvent });
    const gsi = createGsiHandler(deps);

    gsi.recursiveDiff(
      '',
      { player: { kills: 2 } },
      { player: null } as any,
      defaultContext,
    );

    expect(logEvent).not.toHaveBeenCalled();
  });

  it('handles multiple keys at the same level', () => {
    const logEvent = mock(async () => {});
    const deps = createMockDeps({ logEvent });
    const gsi = createGsiHandler(deps);

    gsi.recursiveDiff(
      'player.',
      { kills: 1, deaths: 0 },
      { kills: 3, deaths: 2 },
      defaultContext,
    );

    expect(logEvent).toHaveBeenCalledTimes(2);
    const eventNames = (logEvent.mock.calls as any[]).map((c) => c[4]);
    expect(eventNames).toContain('player.kills');
    expect(eventNames).toContain('player.deaths');
  });
});

// ─── handleGameEvent — condition matching ────────────────────────

describe('handleGameEvent — condition matching', () => {
  function setupConditionTest(mapping: MappingEntry[]) {
    const playSound = mock(() => {});
    const deps = createMockDeps({
      getMapping: () => mapping,
      getConnections: () => ({ ch1: { playSound } }),
    });
    const gsi = createGsiHandler(deps);
    return { gsi, playSound };
  }

  it('condition "*" always plays', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'player.kills', sound: 'kill.mp3', condition: '*', value: 0 },
    ]);

    await gsi.handleGameEvent('player.kills', 999, defaultContext);
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith('kill.mp3');
  });

  it('condition ">" plays when value exceeds threshold', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'player.kills', sound: 'kill.mp3', condition: '>', value: 5 },
    ]);

    await gsi.handleGameEvent('player.kills', 6, defaultContext);
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it('condition ">" does not play when value equals threshold', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'player.kills', sound: 'kill.mp3', condition: '>', value: 5 },
    ]);

    await gsi.handleGameEvent('player.kills', 5, defaultContext);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('condition ">" does not play when value is below threshold', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'player.kills', sound: 'kill.mp3', condition: '>', value: 5 },
    ]);

    await gsi.handleGameEvent('player.kills', 3, defaultContext);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('condition "<" plays when value is below threshold', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'player.deaths', sound: 'death.mp3', condition: '<', value: 3 },
    ]);

    await gsi.handleGameEvent('player.deaths', 2, defaultContext);
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it('condition "<" does not play when value equals threshold', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'player.deaths', sound: 'death.mp3', condition: '<', value: 3 },
    ]);

    await gsi.handleGameEvent('player.deaths', 3, defaultContext);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('condition "===" plays on exact match', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'map.game_state', sound: 'start.mp3', condition: '===', value: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' },
    ]);

    await gsi.handleGameEvent('map.game_state', 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', defaultContext);
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it('condition "===" does not play on mismatch', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'map.game_state', sound: 'start.mp3', condition: '===', value: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' },
    ]);

    await gsi.handleGameEvent('map.game_state', 'DOTA_GAMERULES_STATE_PRE_GAME', defaultContext);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('condition "!==" plays on non-match', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'map.game_state', sound: 'change.mp3', condition: '!==', value: 'DOTA_GAMERULES_STATE_INIT' },
    ]);

    await gsi.handleGameEvent('map.game_state', 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', defaultContext);
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it('condition "!==" does not play on match', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'map.game_state', sound: 'change.mp3', condition: '!==', value: 'DOTA_GAMERULES_STATE_INIT' },
    ]);

    await gsi.handleGameEvent('map.game_state', 'DOTA_GAMERULES_STATE_INIT', defaultContext);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('unrecognized condition does not play', async () => {
    const { gsi, playSound } = setupConditionTest([
      { event: 'player.kills', sound: 'kill.mp3', condition: '~' as any, value: 5 },
    ]);

    await gsi.handleGameEvent('player.kills', 5, defaultContext);
    expect(playSound).not.toHaveBeenCalled();
  });
});

// ─── handleGameEvent — behavior ─────────────────────────────────

describe('handleGameEvent — behavior', () => {
  it('does not call logEvent for map.game_time', async () => {
    const logEvent = mock(async () => {});
    const deps = createMockDeps({ logEvent });
    const gsi = createGsiHandler(deps);

    await gsi.handleGameEvent('map.game_time', 120, defaultContext);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('does not call logEvent for map.clock_time', async () => {
    const logEvent = mock(async () => {});
    const deps = createMockDeps({ logEvent });
    const gsi = createGsiHandler(deps);

    await gsi.handleGameEvent('map.clock_time', 120, defaultContext);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('calls logEvent for other numeric events', async () => {
    const logEvent = mock(async () => {});
    const deps = createMockDeps({ logEvent });
    const gsi = createGsiHandler(deps);

    await gsi.handleGameEvent('player.kills', 5, defaultContext);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      defaultContext.accountID,
      defaultContext.matchID,
      defaultContext.timestamp,
      defaultContext.gameTime,
      'player.kills',
      5,
    );
  });

  it('does not call logEvent when value is a string', async () => {
    const logEvent = mock(async () => {});
    const deps = createMockDeps({ logEvent });
    const gsi = createGsiHandler(deps);

    await gsi.handleGameEvent('map.game_state', 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', defaultContext);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('first-match-wins: only the first matching mapping plays', async () => {
    const playSound = mock(() => {});
    const deps = createMockDeps({
      getMapping: () => [
        { event: 'player.kills', sound: 'first.mp3', condition: '*', value: 0 },
        { event: 'player.kills', sound: 'second.mp3', condition: '*', value: 0 },
      ],
      getConnections: () => ({ ch1: { playSound } }),
    });
    const gsi = createGsiHandler(deps);

    await gsi.handleGameEvent('player.kills', 5, defaultContext);
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith('first.mp3');
  });

  it('plays sound on every active connection', async () => {
    const playSound1 = mock(() => {});
    const playSound2 = mock(() => {});
    const deps = createMockDeps({
      getMapping: () => [{ event: 'player.kills', sound: 'kill.mp3', condition: '*', value: 0 }],
      getConnections: () => ({
        ch1: { playSound: playSound1 },
        ch2: { playSound: playSound2 },
      }),
    });
    const gsi = createGsiHandler(deps);

    await gsi.handleGameEvent('player.kills', 5, defaultContext);
    expect(playSound1).toHaveBeenCalledTimes(1);
    expect(playSound1).toHaveBeenCalledWith('kill.mp3');
    expect(playSound2).toHaveBeenCalledTimes(1);
    expect(playSound2).toHaveBeenCalledWith('kill.mp3');
  });

  it('does not play sound when event matches no mapping', async () => {
    const playSound = mock(() => {});
    const deps = createMockDeps({
      getMapping: () => [{ event: 'player.deaths', sound: 'death.mp3', condition: '*', value: 0 }],
      getConnections: () => ({ ch1: { playSound } }),
    });
    const gsi = createGsiHandler(deps);

    await gsi.handleGameEvent('player.kills', 5, defaultContext);
    expect(playSound).not.toHaveBeenCalled();
  });
});

// ─── handleGameEvent — game summary trigger ─────────────────────

describe('handleGameEvent — game summary trigger', () => {
  it('triggers gameSummary on POST_GAME state', async () => {
    // gameSummary reads Bun.file('settings.json'), so we mock it to avoid side effects
    const originalBunFile = Bun.file.bind(Bun);
    const mockFile = mock(() => ({ exists: async () => false }));
    (Bun as any).file = mockFile;

    const deps = createMockDeps();
    const gsi = createGsiHandler(deps);

    // This should trigger gameSummary, which will try to read settings.json
    // Since we mocked Bun.file to return exists: false, it won't proceed further
    await gsi.handleGameEvent('map.game_state', 'DOTA_GAMERULES_STATE_POST_GAME', defaultContext);

    expect(mockFile).toHaveBeenCalledWith('settings.json');

    (Bun as any).file = originalBunFile;
  });

  it('does not trigger gameSummary for other game states', async () => {
    const originalBunFile = Bun.file.bind(Bun);
    const mockFile = mock(() => ({ exists: async () => false }));
    (Bun as any).file = mockFile;

    const deps = createMockDeps();
    const gsi = createGsiHandler(deps);

    await gsi.handleGameEvent('map.game_state', 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', defaultContext);

    expect(mockFile).not.toHaveBeenCalled();

    (Bun as any).file = originalBunFile;
  });
});
