/**
 * Personal-plane BUNDLE (Phase C, functional core): the signed + encrypted
 * per-device shard format and the manifest writer/reader. No IO, no clock, no
 * randomness beyond the vetted `../crypto` primitives — the imperative shell
 * (`packages/cli/src/backup`) drives these against a `StorageTransport`.
 */

export {
  toBase64,
  fromBase64,
  toBase64Url,
  fromBase64Url,
  utf8Encode,
  utf8Decode,
  canonicalStringify,
  serializeJson,
  deserializeJson,
} from "./serialize.js";

export {
  SHARD_SCHEMA_VERSION,
  serializeShard,
  deserializeShard,
  sealShard,
  openShard,
  encodeShardFile,
  decodeShardFile,
} from "./shard.js";
export type { ShardFile, SealShardOptions, OpenShardOptions } from "./shard.js";

export {
  MANIFEST_FORMAT_VERSION,
  manifestHeader,
  serializeManifestBody,
  deserializeManifestBody,
  sealManifest,
  openManifest,
  encodeManifest,
  decodeManifest,
  encryptPathComponents,
  decryptPathComponents,
  emptyManifestBody,
  upsertDevice,
  upsertFileIndex,
  removeFileIndex,
  fileState,
} from "./manifest.js";
export type { SealManifestOptions, OpenManifestOptions } from "./manifest.js";

export { isLocallyOriginated, selectLocallyOriginated } from "./export-selector.js";
