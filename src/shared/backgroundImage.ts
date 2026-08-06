const preferredBackgroundMimeType = "image/webp";
const maxBackgroundDimension = 3840;
const targetBackgroundBytes = 1024 * 1024;
const minimumBackgroundDimension = 1280;
const encodingQualities = [0.92, 0.84, 0.76, 0.68];

export interface PreparedBackgroundImage {
  dataUrl: string;
  height: number;
  sourceBytes: number;
  storedBytes: number;
  width: number;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("图片编码失败"));
      },
      preferredBackgroundMimeType,
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onabort = () => reject(new Error("图片读取已取消"));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("图片读取失败"));
    };
    reader.readAsDataURL(blob);
  });
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";

  try {
    image.src = objectUrl;
    await image.decode();
    return image;
  } catch {
    throw new Error("图片内容无法解码");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function fitWithin(width: number, height: number, maximumDimension: number) {
  const scale = Math.min(1, maximumDimension / Math.max(width, height));
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

export async function prepareBackgroundImage(file: File): Promise<PreparedBackgroundImage> {
  const image = await loadImage(file);
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error("图片尺寸无效");
  }

  let dimensions = fitWithin(image.naturalWidth, image.naturalHeight, maxBackgroundDimension);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    throw new Error("当前环境无法处理图片");
  }

  let encoded = new Blob();
  while (true) {
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    context.clearRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);

    for (const quality of encodingQualities) {
      encoded = await canvasToBlob(canvas, quality);
      if (encoded.size <= targetBackgroundBytes) {
        break;
      }
    }

    if (
      encoded.size <= targetBackgroundBytes ||
      Math.max(dimensions.width, dimensions.height) <= minimumBackgroundDimension
    ) {
      break;
    }

    dimensions = fitWithin(dimensions.width, dimensions.height, Math.round(Math.max(
      minimumBackgroundDimension,
      Math.max(dimensions.width, dimensions.height) * 0.82,
    )));
  }

  return {
    dataUrl: await blobToDataUrl(encoded),
    height: dimensions.height,
    sourceBytes: file.size,
    storedBytes: encoded.size,
    width: dimensions.width,
  };
}

export function formatImageBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
