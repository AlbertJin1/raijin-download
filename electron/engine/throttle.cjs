'use strict';
const { sleep } = require('./util.cjs');

/**
 * Deficit-based token bucket. Callers take bytes after they arrive; when the
 * bucket goes negative the caller waits until the debt is repaid. This keeps
 * throughput smooth for any chunk size and is fair across many connections.
 */
class TokenBucket {
  constructor(bytesPerSecond = 0) {
    this.rate = 0;
    this.tokens = 0;
    this.last = Date.now();
    this.setRate(bytesPerSecond);
  }

  setRate(bytesPerSecond) {
    this.refill();
    const rate = Math.max(0, Number(bytesPerSecond) || 0);
    if (rate === this.rate) return;
    this.rate = rate;
    this.capacity = rate ? Math.max(16 * 1024, rate * 0.25) : 0;
    this.tokens = Math.min(this.tokens, this.capacity);
    if (!rate) this.tokens = 0;
  }

  refill() {
    const now = Date.now();
    if (this.rate) this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  async take(bytes, signal) {
    if (!this.rate) return;
    this.refill();
    this.tokens -= bytes;
    while (this.tokens < 0 && this.rate) {
      const wait = Math.min(1000, Math.max(5, (-this.tokens / this.rate) * 1000));
      await sleep(wait, signal);
      this.refill();
    }
  }
}

module.exports = { TokenBucket };
