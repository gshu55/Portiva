type HttpFileReadRequest = {
  file: File;
  id: string;
};

type HttpFileReadResponse =
  | {
      base64: string;
      id: string;
      ok: true;
    }
  | {
      error: string;
      id: string;
      ok: false;
    };

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

self.onmessage = async (event: MessageEvent<HttpFileReadRequest>) => {
  const { file, id } = event.data;

  try {
    if (file.size > HTTP_FILE_UPLOAD_MAX_BYTES) {
      throw new Error(`单个上传文件不能超过 ${formatHttpByteLimit(HTTP_FILE_UPLOAD_MAX_BYTES)}。`);
    }
    const base64 = arrayBufferToBase64(await file.arrayBuffer());
    self.postMessage({ base64, id, ok: true } satisfies HttpFileReadResponse);
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "文件读取失败。",
      id,
      ok: false,
    } satisfies HttpFileReadResponse);
  }
};

export {};
import { formatHttpByteLimit, HTTP_FILE_UPLOAD_MAX_BYTES } from "./httpLimits";
