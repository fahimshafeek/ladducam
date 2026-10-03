/**
 * Friendly Acoustic Chime Synthesizer via Web Audio API
 * Procedurally generates warm, notice-demanding chimes tuned for
 * 10-15ft tripod distance without clipping or harsh frequencies.
 */

class ChimeSynthesizer {
	private audioCtx: AudioContext | null = null;

	private getContext(): AudioContext | null {
		if (typeof window === 'undefined') return null;
		try {
			if (!this.audioCtx) {
				const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
				if (AudioCtxClass) {
					this.audioCtx = new AudioCtxClass();
				}
			}
			if (this.audioCtx && this.audioCtx.state === 'suspended') {
				this.audioCtx.resume().catch(() => {});
			}
			return this.audioCtx;
		} catch (_) {
			return null;
		}
	}

	/**
	 * Warm, uplifting, highly noticeable "I'm Listening" Chime (A5 -> C#6 -> E6 major triad).
	 * Formulated with fundamental sine + subtle harmonic shimmer for acoustic clarity across a room.
	 */
	playVoiceListenChime() {
		const ctx = this.getContext();
		if (!ctx) return;

		try {
			const now = ctx.currentTime;
			// A5 (880Hz), C#6 (1108.7Hz), E6 (1318.5Hz)
			const notes = [
				{ freq: 880.0, time: 0.0, dur: 0.28, vol: 0.22 },
				{ freq: 1108.7, time: 0.08, dur: 0.32, vol: 0.25 },
				{ freq: 1318.5, time: 0.16, dur: 0.45, vol: 0.28 }
			];

			for (const { freq, time, dur, vol } of notes) {
				const noteStart = now + time;

				// 1. Fundamental tone (crystal-clear sine)
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = 'sine';
				osc.frequency.setValueAtTime(freq, noteStart);

				// Quick 4ms attack, smooth exponential bell decay
				gain.gain.setValueAtTime(0.001, noteStart);
				gain.gain.linearRampToValueAtTime(vol, noteStart + 0.006);
				gain.gain.exponentialRampToValueAtTime(0.001, noteStart + dur);

				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.start(noteStart);
				osc.stop(noteStart + dur);

				// 2. Harmonic shimmer overtone (triangle at 2x octave for acoustic penetration)
				const shimmerOsc = ctx.createOscillator();
				const shimmerGain = ctx.createGain();
				shimmerOsc.type = 'triangle';
				shimmerOsc.frequency.setValueAtTime(freq * 2, noteStart);

				shimmerGain.gain.setValueAtTime(0.001, noteStart);
				shimmerGain.gain.linearRampToValueAtTime(vol * 0.12, noteStart + 0.005);
				shimmerGain.gain.exponentialRampToValueAtTime(0.0005, noteStart + dur * 0.6);

				shimmerOsc.connect(shimmerGain);
				shimmerGain.connect(ctx.destination);
				shimmerOsc.start(noteStart);
				shimmerOsc.stop(noteStart + dur * 0.6);
			}
		} catch (e) {
			console.warn('[Chime] Error playing listen chime:', e);
		}
	}

	/**
	 * Pleasant, uplifting chime when White Box AI analysis response arrives
	 * Bright dual-bell chime (G5 784Hz -> C6 1046.5Hz) with warm harmonic decay.
	 */
	playWhiteBoxArrivalChime() {
		const ctx = this.getContext();
		if (!ctx) return;

		try {
			const now = ctx.currentTime;
			const notes = [
				{ freq: 783.99, time: 0.0, dur: 0.24, vol: 0.22 },
				{ freq: 1046.5, time: 0.1, dur: 0.42, vol: 0.26 }
			];

			for (const { freq, time, dur, vol } of notes) {
				const start = now + time;
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = 'sine';
				osc.frequency.setValueAtTime(freq, start);

				gain.gain.setValueAtTime(0.001, start);
				gain.gain.linearRampToValueAtTime(vol, start + 0.006);
				gain.gain.exponentialRampToValueAtTime(0.001, start + dur);

				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.start(start);
				osc.stop(start + dur);

				// Light harmonic overtone for room penetration
				const overtone = ctx.createOscillator();
				const overtoneGain = ctx.createGain();
				overtone.type = 'triangle';
				overtone.frequency.setValueAtTime(freq * 1.5, start);

				overtoneGain.gain.setValueAtTime(0.001, start);
				overtoneGain.gain.linearRampToValueAtTime(vol * 0.1, start + 0.005);
				overtoneGain.gain.exponentialRampToValueAtTime(0.0005, start + dur * 0.5);

				overtone.connect(overtoneGain);
				overtoneGain.connect(ctx.destination);
				overtone.start(start);
				overtone.stop(start + dur * 0.5);
			}
		} catch (e) {
			console.warn('[Chime] Error playing white box chime:', e);
		}
	}

	/**
	 * Gentle, polite acknowledgement resolve when recording concludes or query is sent
	 */
	playVoiceAckChime() {
		const ctx = this.getContext();
		if (!ctx) return;

		try {
			const now = ctx.currentTime;
			// Descending soft dual pip (E6 1318Hz -> A5 880Hz)
			const notes = [
				{ freq: 1318.5, time: 0.0, dur: 0.12, vol: 0.14 },
				{ freq: 880.0, time: 0.08, dur: 0.18, vol: 0.12 }
			];

			for (const { freq, time, dur, vol } of notes) {
				const start = now + time;
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = 'sine';
				osc.frequency.setValueAtTime(freq, start);

				gain.gain.setValueAtTime(0.001, start);
				gain.gain.linearRampToValueAtTime(vol, start + 0.005);
				gain.gain.exponentialRampToValueAtTime(0.001, start + dur);

				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.start(start);
				osc.stop(start + dur);
			}
		} catch (e) {
			console.warn('[Chime] Error playing ack chime:', e);
		}
	}
}

export const chime = new ChimeSynthesizer();
