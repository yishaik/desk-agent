declare module 'qrcode' {
  // The server-side Promise API used by the pairing UI. Other qrcode APIs
  // are intentionally omitted; extend this declaration when they are needed.
  interface QRCodeDataURLOptions {
    width?: number;
    margin?: number;
  }

  export function toDataURL(text: string, options?: QRCodeDataURLOptions): Promise<string>;
}
