// Audio thread: anti-aliasing box resampler with continuous phase, 100 ms PCM16 packets.
// No codec, ffmpeg process, or MediaRecorder delay between microphone and model.
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.sum = 0;
    this.weight = 0;
    this.packet = new Int16Array(1600);
    this.offset = 0;
    this.active = true;
    this.port.onmessage = event => {
      if (event.data === 'flush') {
        if (this.offset) this.port.postMessage({ audio: this.packet.slice(0, this.offset).buffer });
        this.offset = 0;
        this.active = false;
        this.port.postMessage({ flushed: true });
      }
    };
  }

  process(inputs) {
    const data = inputs[0]?.[0];
    if (!data || !this.active) return true;
    let energy = 0;
    for (const value of data) {
      energy += value * value;
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += value * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-8) {
          const sample = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.packet[this.offset++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
          this.sum = this.weight = 0;
          if (this.offset === this.packet.length) {
            this.port.postMessage({ audio: this.packet.buffer, level: Math.sqrt(energy / data.length) }, [this.packet.buffer]);
            this.packet = new Int16Array(1600);
            this.offset = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
