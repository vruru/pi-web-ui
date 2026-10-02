import { useEffect, useState } from "react";
import { FiVolume2 } from "react-icons/fi";
import type { SoundKind, SoundSettings } from "../sounds";
import { DEFAULT_TTS_SETTINGS, isTtsAvailable, resolveVoice, type TtsSettings } from "../tts";
import { useT } from "../i18n";

interface SoundSettingsProps {
	settings: SoundSettings;
	onChange: (settings: SoundSettings) => void;
	/** Play a preview cue (the actual synthesized sound). */
	onPreview: (kind: SoundKind) => void;
}

const SOUND_EVENTS: {
	kind: SoundKind;
	labelKey: "sound.question" | "sound.done" | "sound.start" | "sound.error" | "sound.approval";
	descKey: "sound.question.desc" | "sound.done.desc" | "sound.start.desc" | "sound.error.desc" | "sound.approval.desc";
}[] = [
	{
		kind: "question",
		labelKey: "sound.question",
		descKey: "sound.question.desc",
	},
	{ kind: "done", labelKey: "sound.done", descKey: "sound.done.desc" },
	{ kind: "start", labelKey: "sound.start", descKey: "sound.start.desc" },
	{ kind: "error", labelKey: "sound.error", descKey: "sound.error.desc" },
	{ kind: "approval", labelKey: "sound.approval", descKey: "sound.approval.desc" },
];

export function SoundSettingsPanel({ settings, onChange, onPreview }: SoundSettingsProps) {
	const t = useT();
	const toggle = (patch: Partial<SoundSettings>) => onChange({ ...settings, ...patch });

	return (
		<div className="sound-menu">
			<div className="dd-header">{t("soundHeader")}</div>

			<label className="sound-row sound-master">
				<span className="sound-label">
					<FiVolume2 className="sound-icon" />
					<span>{t("enableSound")}</span>
				</span>
				<input type="checkbox" checked={settings.enabled} onChange={(e) => toggle({ enabled: e.target.checked })} />
			</label>

			{SOUND_EVENTS.map(({ kind, labelKey, descKey }) => (
				<label key={kind} className={`sound-row ${settings.enabled ? "" : "disabled"}`}>
					<span className="sound-label">
						<span className="sound-name">{t(labelKey)}</span>
						<span className="sound-desc">{t(descKey)}</span>
					</span>
					<span className="sound-right">
						<button
							type="button"
							className="sound-preview"
							title={t("preview")}
							disabled={!settings.enabled}
							onClick={(e) => {
								e.preventDefault();
								onPreview(kind);
							}}
						>
							{t("preview")}
						</button>
						<input
							type="checkbox"
							checked={settings[kind]}
							disabled={!settings.enabled}
							onChange={(e) => toggle({ [kind]: e.target.checked })}
						/>
					</span>
				</label>
			))}

			<div className={`sound-volume ${settings.enabled ? "" : "disabled"}`}>
				<span className="sound-name">{t("volume")}</span>
				<input
					type="range"
					min={0}
					max={100}
					step={5}
					value={settings.volume}
					disabled={!settings.enabled}
					onChange={(e) => toggle({ volume: Number(e.target.value) })}
				/>
				<span className="sound-vol-num">{settings.volume}%</span>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Text-to-speech (Settings → Sound & Voice → TTS block)
// ---------------------------------------------------------------------------

interface TtsSettingsProps {
	settings: TtsSettings;
	onChange: (settings: TtsSettings) => void;
	/** Speak the sample line with current settings (preview button). */
	onPreview: () => void;
}

/** Chrome populates getVoices() asynchronously; this hook re-reads on the change event.
 *  localService=false → the voice is synthesized remotely (needs network, e.g. Edge
 *  "Natural" voices); true → fully offline OS speech. Surfaced in the dropdown so
 *  users can tell the two apart. */
function useVoices(): { voiceURI: string; lang: string; name: string; localService: boolean }[] {
	const [voices, setVoices] = useState<{ voiceURI: string; lang: string; name: string; localService: boolean }[]>([]);
	useEffect(() => {
		if (!isTtsAvailable()) return;
		const synth = window.speechSynthesis;
		const read = () =>
			setVoices(
				synth
					.getVoices()
					.map((v) => ({ voiceURI: v.voiceURI, lang: v.lang, name: v.name, localService: v.localService })),
			);
		read();
		synth.addEventListener?.("voiceschanged", read);
		return () => synth.removeEventListener?.("voiceschanged", read);
	}, []);
	return voices;
}

export function TtsSettingsPanel({ settings, onChange, onPreview }: TtsSettingsProps) {
	const t = useT();
	const voices = useVoices();
	const available = isTtsAvailable();
	const toggle = (patch: Partial<TtsSettings>) => onChange({ ...settings, ...patch });

	return (
		<div className="sound-menu">
			<div className="dd-header">{t("ttsHeader")}</div>

			{!available && <div className="sound-desc tts-unavailable">{t("ttsUnavailable")}</div>}

			<label className={`sound-row sound-master ${available ? "" : "disabled"}`}>
				<span className="sound-label">
					<FiVolume2 className="sound-icon" />
					<span>{t("ttsEnable")}</span>
					<span className="sound-desc">{t("ttsEnableDesc")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.enabled}
					disabled={!available}
					onChange={(e) => toggle({ enabled: e.target.checked })}
				/>
			</label>

			<label className={`sound-row ${settings.enabled && available ? "" : "disabled"}`}>
				<span className="sound-label">
					<span className="sound-name">{t("ttsAnnounce")}</span>
					<span className="sound-desc">{t("ttsAnnounceDesc")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.announce}
					disabled={!settings.enabled || !available}
					onChange={(e) => toggle({ announce: e.target.checked })}
				/>
			</label>

			<label className={`sound-row ${settings.enabled && available ? "" : "disabled"}`}>
				<span className="sound-label">
					<span className="sound-name">{t("ttsReadReplies")}</span>
					<span className="sound-desc">{t("ttsReadRepliesDesc")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.readReplies}
					disabled={!settings.enabled || !available}
					onChange={(e) => toggle({ readReplies: e.target.checked })}
				/>
			</label>

			<div className={`sound-volume ${settings.enabled && available ? "" : "disabled"}`}>
				<span className="sound-name">{t("ttsRate")}</span>
				<input
					type="range"
					min={0.5}
					max={2}
					step={0.1}
					value={settings.rate}
					disabled={!settings.enabled || !available}
					onChange={(e) => toggle({ rate: Number(e.target.value) })}
				/>
				<span className="sound-vol-num">{settings.rate.toFixed(1)}×</span>
			</div>

			<div className={`sound-volume ${settings.enabled && available ? "" : "disabled"}`}>
				<span className="sound-name">{t("ttsVoice")}</span>
				<select
					className="set-input tts-voice-select"
					value={settings.voiceURI}
					disabled={!settings.enabled || !available}
					onChange={(e) => toggle({ voiceURI: e.target.value })}
				>
					<option value="">{t("ttsVoiceAuto")}</option>
					{voices.map((v) => (
						<option key={v.voiceURI} value={v.voiceURI}>
							{v.name} ({v.lang}){v.localService ? "" : ` · ${t("ttsVoiceOnline")}`}
						</option>
					))}
				</select>
			</div>

			<div className={`sound-volume ${settings.enabled && available ? "" : "disabled"}`}>
				<button
					type="button"
					className="sound-preview tts-preview"
					disabled={!settings.enabled || !available}
					onClick={() => {
						// Sanity voice check: an explicitly chosen voice that has
						// disappeared (browser restart, removed pack) falls back to auto.
						if (settings.voiceURI && !resolveVoice(settings.voiceURI, voices, navigator.language)) {
							onChange({ ...DEFAULT_TTS_SETTINGS, ...settings, voiceURI: "" });
							return;
						}
						onPreview();
					}}
				>
					{t("preview")}
				</button>
			</div>
		</div>
	);
}
