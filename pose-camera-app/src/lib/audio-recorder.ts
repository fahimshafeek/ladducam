/**
 * Robust In-Browser Audio Recorder & WAV 16-bit PCM Encoder
 * Records microphone audio and produces standard RIFF/WAVE 16-bit PCM files
 * universally compatible with Whisper STT and n8n audio pipelines.
 */

export interface RecordingResult {
	blob: Blob;
	base64: string;
	durationMs: number;
	sampleRate: number;
	sizeBytes: number;
}

export class AudioRecorder {
	private mediaStream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private processorNode: ScriptProcessorNode | null = null;
	private pcmChunks: Float32Array[] = [];
	private startTime: number = 0;
	private isRecording: boolean = false;

	public currentRms: number = 0;
	public speechDetected: boolean = false;
	public lastSpeechTime: number = 0;
	public speechThreshold: number = 0.012;

	get recording(): boolean {
		return this.isRecording;
	}

	/**
	 * Pre-warm or request microphone permissions
	 */
	async requestPermission(): Promise<boolean> {
		try {
			if (!navigator?.mediaDevices?.getUserMedia) return false;
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			// Release immediately
			stream.getTracks().forEach((track) => track.stop());
			return true;
		} catch (err) {
			console.warn('Microphone permission request failed:', err);
			return false;
		}
	}

	/**
	 * Begin recording audio from microphone
	 */
	async start(): Promise<void> {
		if (this.isRecording) return;

		this.pcmChunks = [];
		this.startTime = Date.now();
		this.speechDetected = false;
		this.lastSpeechTime = 0;
		this.currentRms = 0;

		if (!navigator?.mediaDevices?.getUserMedia) {
			throw new Error('Microphone access is not supported on this device/browser');
		}

		// Request audio stream with optimal speech recognition settings, falling back if constraints fail
		try {
			this.mediaStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					channelCount: 1
				}
			});
		} catch (constraintErr) {
			console.warn('Detailed audio constraints failed, trying basic audio: true', constraintErr);
			this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		}

		const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
		this.audioContext = new AudioCtx();

		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume();
		}

		this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

		// Buffer size 4096 gives smooth captures with low latency
		this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);

		this.processorNode.onaudioprocess = (event) => {
			if (!this.isRecording) return;
			const channelData = event.inputBuffer.getChannelData(0);

			// Calculate RMS energy of current audio buffer
			let sum = 0;
			for (let i = 0; i < channelData.length; i++) {
				sum += channelData[i] * channelData[i];
			}
			const rms = Math.sqrt(sum / channelData.length);
			this.currentRms = rms;

			if (rms >= this.speechThreshold) {
				this.speechDetected = true;
				this.lastSpeechTime = Date.now();
			}

			// Clone channel chunk
			this.pcmChunks.push(new Float32Array(channelData));
		};

		this.sourceNode.connect(this.processorNode);
		// Connect to destination to keep processor node active in Web Audio pipeline
		this.processorNode.connect(this.audioContext.destination);

		this.isRecording = true;
	}

	/**
	 * Stop recording and encode to standard 16-bit PCM .wav file
	 */
	async stop(): Promise<RecordingResult> {
		if (!this.isRecording) {
			throw new Error('Recording was not started');
		}

		this.isRecording = false;
		const durationMs = Math.max(1, Date.now() - this.startTime);

		// Clean up nodes
		if (this.processorNode) {
			this.processorNode.disconnect();
			this.processorNode.onaudioprocess = null;
			this.processorNode = null;
		}

		if (this.sourceNode) {
			this.sourceNode.disconnect();
			this.sourceNode = null;
		}

		if (this.mediaStream) {
			this.mediaStream.getTracks().forEach((track) => track.stop());
			this.mediaStream = null;
		}

		const sampleRate = this.audioContext ? this.audioContext.sampleRate : 44100;
		if (this.audioContext) {
			try {
				await this.audioContext.close();
			} catch (_) {}
			this.audioContext = null;
		}

		// Flatten captured chunks
		let totalSamples = 0;
		for (const chunk of this.pcmChunks) {
			totalSamples += chunk.length;
		}

		const mergedSamples = new Float32Array(totalSamples);
		let offset = 0;
		for (const chunk of this.pcmChunks) {
			mergedSamples.set(chunk, offset);
			offset += chunk.length;
		}

		// Downsample to 16,000 Hz for Whisper STT efficiency if source rate is higher
		const targetRate = 16000;
		const finalSamples =
			sampleRate !== targetRate ? this.downsample(mergedSamples, sampleRate, targetRate) : mergedSamples;

		const wavBlob = this.encodeWAV(finalSamples, targetRate);
		const base64 = await this.blobToBase64(wavBlob);

		return {
			blob: wavBlob,
			base64,
			durationMs,
			sampleRate: targetRate,
			sizeBytes: wavBlob.size
		};
	}

	/**
	 * Cancel recording without processing output
	 */
	cancel() {
		this.isRecording = false;
		if (this.processorNode) {
			this.processorNode.disconnect();
			this.processorNode.onaudioprocess = null;
			this.processorNode = null;
		}
		if (this.sourceNode) {
			this.sourceNode.disconnect();
			this.sourceNode = null;
		}
		if (this.mediaStream) {
			this.mediaStream.getTracks().forEach((track) => track.stop());
			this.mediaStream = null;
		}
		if (this.audioContext) {
			this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}
		this.pcmChunks = [];
	}

	/**
	 * High-quality linear interpolation downsampler
	 */
	private downsample(buffer: Float32Array, inputRate: number, outputRate: number): Float32Array {
		if (outputRate >= inputRate) return buffer;

		const ratio = inputRate / outputRate;
		const newLength = Math.round(buffer.length / ratio);
		const result = new Float32Array(newLength);

		let offsetResult = 0;
		let offsetBuffer = 0;

		while (offsetResult < result.length) {
			const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
			let accum = 0;
			let count = 0;

			for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
				accum += buffer[i];
				count++;
			}

			result[offsetResult] = count > 0 ? accum / count : 0;
			offsetResult++;
			offsetBuffer = nextOffsetBuffer;
		}

		return result;
	}

	/**
	 * Builds a standard 44-byte RIFF/WAVE header and writes 16-bit linear PCM samples
	 */
	private encodeWAV(samples: Float32Array, sampleRate: number): Blob {
		const bytesPerSample = 2; // 16-bit = 2 bytes
		const channels = 1; // mono
		const dataByteCount = samples.length * bytesPerSample;
		const buffer = new ArrayBuffer(44 + dataByteCount);
		const view = new DataView(buffer);

		// 1. RIFF Chunk Descriptor
		this.writeAscii(view, 0, 'RIFF');
		view.setUint32(4, 36 + dataByteCount, true); // ChunkSize = 36 + SubChunk2Size
		this.writeAscii(view, 8, 'WAVE');

		// 2. "fmt " Sub-chunk
		this.writeAscii(view, 12, 'fmt ');
		view.setUint32(16, 16, true); // Subchunk1Size = 16 for PCM
		view.setUint16(20, 1, true); // AudioFormat = 1 (Linear PCM)
		view.setUint16(22, channels, true); // NumChannels = 1 (Mono)
		view.setUint32(24, sampleRate, true); // SampleRate
		view.setUint32(28, sampleRate * channels * bytesPerSample, true); // ByteRate
		view.setUint16(32, channels * bytesPerSample, true); // BlockAlign = channels * bytesPerSample
		view.setUint16(34, 16, true); // BitsPerSample = 16

		// 3. "data" Sub-chunk
		this.writeAscii(view, 36, 'data');
		view.setUint32(40, dataByteCount, true);

		// 4. PCM audio samples
		let offset = 44;
		for (let i = 0; i < samples.length; i++, offset += 2) {
			const s = Math.max(-1, Math.min(1, samples[i]));
			// Convert float -1.0..1.0 to 16-bit signed integer
			const val = s < 0 ? s * 0x8000 : s * 0x7fff;
			view.setInt16(offset, val, true);
		}

		return new Blob([buffer], { type: 'audio/wav' });
	}

	private writeAscii(view: DataView, offset: number, str: string) {
		for (let i = 0; i < str.length; i++) {
			view.setUint8(offset + i, str.charCodeAt(i));
		}
	}

	private blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onloadend = () => {
				const res = reader.result as string;
				const commaIdx = res.indexOf(',');
				resolve(commaIdx !== -1 ? res.substring(commaIdx + 1) : res);
			};
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}
}

export const audioRecorder = new AudioRecorder();
