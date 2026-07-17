export const HTTP_FILE_UPLOAD_MAX_BYTES = 128 * 1024 * 1024;
export const HTTP_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const HTTP_STREAM_PREVIEW_MAX_CHARS = 2 * 1024 * 1024;

export function formatHttpByteLimit(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
