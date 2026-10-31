import type { AudioLevelObserver, Producer, Router } from "mediasoup/types";
import type { SpeakerStore } from "./speaker-store.js";

interface Sample {
  producer: Producer;
  volume: number;
  heardAt: number;
  streak: number;
}

export class RoomSpeakerObserver {
  readonly #samples = new Map<string, Sample>();
  readonly #producers = new Map<string, Producer>();
  readonly #timer: ReturnType<typeof setInterval>;
  #pending: Promise<void> | undefined;
  #closed = false;
  #dominant: string | null = null;
  #dominantAt = 0;
  #challenger: string | null = null;
  #challengeCount = 0;
  #challengerHeardAt = 0;
  private constructor(
    readonly roomId: string,
    readonly observer: AudioLevelObserver,
    readonly store: SpeakerStore,
    readonly report: (error: unknown) => void,
  ) {
    observer.on("volumes", (volumes) => {
      const now = Date.now();
      for (const { producer, volume } of volumes) {
        if (this.#closed || producer.closed || producer.paused || !this.#producers.has(producer.id))
          continue;
        const previous = this.#samples.get(producer.id);
        const streak =
          volume >= (previous && previous.streak >= 2 ? -56 : -50)
            ? previous && now - previous.heardAt < 900
              ? previous.streak + 1
              : 1
            : 0;
        if (streak) this.#samples.set(producer.id, { producer, volume, heardAt: now, streak });
      }
    });
    this.#timer = setInterval(() => {
      this.#tick();
    }, 250);
    this.#timer.unref();
  }
  static async create(roomId: string, router: Router, store: SpeakerStore, report: (error: unknown) => void) {
    const observer = await router.createAudioLevelObserver({
      maxEntries: 16,
      threshold: -56,
      interval: 250,
    });
    return new RoomSpeakerObserver(roomId, observer, store, report);
  }
  async add(producer: Producer) {
    if (!this.#available()) return;
    await this.observer.addProducer({ producerId: producer.id });
    if (!this.#available()) return;
    this.#producers.set(producer.id, producer);
    producer.observer.on("pause", () => {
      this.#samples.delete(producer.id);
    });
    producer.observer.once("close", () => {
      this.#samples.delete(producer.id);
      this.#producers.delete(producer.id);
    });
  }
  #tick() {
    if (this.#closed || this.#pending) return;
    const now = Date.now();
    for (const [id, sample] of this.#samples)
      if (sample.producer.closed || sample.producer.paused || now - sample.heardAt >= 1000)
        this.#samples.delete(id);
    const active = [...this.#samples.values()]
      .filter((sample) => sample.streak >= 2)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 16);
    const current = active.find((sample) => sample.producer.id === this.#dominant);
    const candidate = active[0];
    if (!current) {
      this.#dominant = candidate?.producer.id ?? null;
      this.#dominantAt = now;
      this.#challenger = null;
      this.#challengeCount = 0;
    } else if (
      candidate &&
      candidate.producer.id !== this.#dominant &&
      candidate.volume >= current.volume + 3 &&
      now - this.#dominantAt >= 1500
    ) {
      if (this.#challenger !== candidate.producer.id) {
        this.#challengeCount = 1;
        this.#challengerHeardAt = candidate.heardAt;
      } else if (this.#challengerHeardAt !== candidate.heardAt) {
        this.#challengeCount++;
        this.#challengerHeardAt = candidate.heardAt;
      }
      this.#challenger = candidate.producer.id;
      if (this.#challengeCount >= 2) {
        this.#dominant = candidate.producer.id;
        this.#dominantAt = now;
        this.#challengeCount = 0;
      }
    } else {
      this.#challenger = null;
      this.#challengeCount = 0;
    }
    const speakers = active.map((sample) => ({
      sessionId: String(sample.producer.appData.participantId),
      level: Math.round(Math.max(0, Math.min(1, (sample.volume + 80) / 80)) * 100) / 100,
    }));
    const dominant = active.find((sample) => sample.producer.id === this.#dominant);
    this.#pending = this.store
      .publish(this.roomId, {
        observedAt: new Date(now),
        speakers,
        dominantSessionId: dominant ? String(dominant.producer.appData.participantId) : null,
      })
      .catch(this.report)
      .finally(() => {
        this.#pending = undefined;
      });
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.observer.close();
    this.#samples.clear();
    this.#producers.clear();
    await this.#pending;
    await this.store.clear(this.roomId).catch(this.report);
  }
  #available() {
    return !this.#closed;
  }
}
