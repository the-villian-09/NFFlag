/** Sends a photo to the API (shrunk in the browser first; the server re-saves it). */
import { shrink } from "@/components/doc-upload";
import { ApiError } from "@/lib/api";

export interface UploadedImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

export async function uploadPhoto(method: "PUT" | "POST", path: string, file: File, max = 2400): Promise<UploadedImage> {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) throw new Error("This needs to be a photo (JPG, PNG or WebP), not a PDF.");
  const body = await shrink(file, max);
  if (body.size > 8 * 1024 * 1024) throw new Error("That photo is too large. The limit is 8 MB.");
  const res = await fetch(`/api/v1${path}`, { method, credentials: "include", headers: { "content-type": body.type || "application/octet-stream" }, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = data.error ?? {};
    throw new ApiError(res.status, err.code ?? "ERROR", res.status === 413 ? "That photo is too large. The limit is 8 MB." : (err.message ?? "The upload didn't work. Please try again."), err);
  }
  return data.image as UploadedImage;
}
