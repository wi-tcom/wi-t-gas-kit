'use strict';

/**
 * 偽の時計。テストの中で時間を進める。
 * GAS 側の new Date() / Date.now() はこの時計を見る（gas-env.js で差し替える）。
 */
function createClock(startMs) {
  let now = startMs === undefined ? Date.UTC(2026, 0, 5, 0, 0, 0) : startMs;
  return {
    now() {
      return now;
    },
    advance(ms) {
      if (!(ms >= 0)) throw new RangeError('clock.advance: ms must be >= 0');
      now += ms;
      return now;
    },
    set(ms) {
      now = ms;
    }
  };
}

/** 偽の時計を見る Date を作る（引数なしの new Date() と Date.now() だけ差し替える）。 */
function createFakeDate(clock) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(clock.now());
      } else {
        super(...args);
      }
    }
    static now() {
      return clock.now();
    }
  }
  return FakeDate;
}

module.exports = { createClock, createFakeDate };
