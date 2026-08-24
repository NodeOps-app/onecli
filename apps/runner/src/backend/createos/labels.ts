/**
 * THE LABEL CHANNEL for the CreateOS backend.
 *
 * Docker gives every object an arbitrary label map, and the whole reconcile
 * story rests on it (docker-backend.ts's LABEL_* constants). CreateOS has no
 * such field. Its two candidates both fail:
 *
 * - `name` is capped at 22 characters and must be a DNS label
 *   (fc internal/control/handlers/server.go: validateSandboxName). One uuid
 *   is 36. Four values never fit.
 * - A file inside the guest would cost one exec per sandbox per list, and
 *   the runner lists several times per work item.
 *
 * What is left is `envs`. The control plane returns the KEYS of a sandbox's
 * env map on every get AND every list (fc internal/hosts/api/service.go:
 * NewSandboxView stamps `Envs: envKeys`), while never returning a value. So
 * the KEY is the label, and the value stays empty.
 *
 * Values are hex-encoded rather than embedded raw because the key must match
 * `^[A-Za-z_][A-Za-z0-9_]*$` (fc's envKeyRe) and a uuid contains hyphens.
 * Hex is reversible, needs no escaping, and stays inside that class.
 *
 * Nothing secret is ever labeled. The four values are a sandbox id, a runner
 * id, a non-secret installation fingerprint, and a payload hash — the same
 * set the Docker backend puts in world-readable docker labels.
 */

/** Present on every object this platform creates. The orphan sweep's filter. */
export const MANAGED_KEY = "ONECLI_MANAGED";

/**
 * Key prefixes, one per labeled value. No prefix is a prefix of another, so
 * a `startsWith` match can never read the wrong label.
 */
export const LABEL_PREFIX = {
  sandbox: "ONECLI_SBX_",
  runner: "ONECLI_RNR_",
  installation: "ONECLI_INST_",
  payload: "ONECLI_HASH_",
} as const;

export type LabelName = keyof typeof LABEL_PREFIX;

const HEX = /^(?:[0-9a-f]{2})+$/;

/** Build the env KEY that carries one label value. */
export const encodeLabel = (name: LabelName, value: string): string =>
  `${LABEL_PREFIX[name]}${Buffer.from(value, "utf8").toString("hex")}`;

/**
 * Recover one label from a sandbox's env key list.
 *
 * Returns null when the label is absent OR unreadable. Both mean the same
 * thing to every caller: this object cannot be identified, so the sweep must
 * never reap it (the same rule the seam states for a missing docker label).
 *
 * `Buffer.from(x, "hex")` truncates silently on malformed input rather than
 * throwing, so the shape is checked before decoding — otherwise a hand-edited
 * key would decode to a short string that could collide with a real id.
 */
export const decodeLabel = (envKeys: readonly string[], name: LabelName): string | null => {
  const prefix = LABEL_PREFIX[name];
  const key = envKeys.find((candidate) => candidate.startsWith(prefix));
  if (!key) return null;
  const hex = key.slice(prefix.length);
  if (!HEX.test(hex)) return null;
  return Buffer.from(hex, "hex").toString("utf8");
};

/** The full marker set stamped onto a sandbox at create time. */
export const buildLabels = (labels: {
  sandboxId: string;
  runnerId: string;
  installationId: string;
  payloadHash: string;
}): Record<string, string> => ({
  [MANAGED_KEY]: "1",
  [encodeLabel("sandbox", labels.sandboxId)]: "1",
  [encodeLabel("runner", labels.runnerId)]: "1",
  [encodeLabel("installation", labels.installationId)]: "1",
  [encodeLabel("payload", labels.payloadHash)]: "1",
});

/** True when this sandbox was created by the onecli platform at all. */
export const isManaged = (envKeys: readonly string[]): boolean => envKeys.includes(MANAGED_KEY);
