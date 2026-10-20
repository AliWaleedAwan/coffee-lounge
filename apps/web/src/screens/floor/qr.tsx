/**
 * QR codes for the printed table cards (LOCAL_LAN_HOSTING.md §2: `http://<shop address>:8080/t/<token>`).
 * Drawn as one SVG path from the module matrix, so it prints sharp at any size and needs
 * no inline markup or images.
 */
import qrcode from 'qrcode-generator';

/** Dark modules of the QR code for `text`, error correction M (survives a coffee stain). */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

const QUIET_ZONE = 4;

export function QrCode({ text, label }: { text: string; label: string }) {
  const matrix = qrMatrix(text);
  const size = matrix.length + QUIET_ZONE * 2;
  let d = '';
  matrix.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (dark) d += `M${String(c + QUIET_ZONE)} ${String(r + QUIET_ZONE)}h1v1h-1z`;
    });
  });
  return (
    <svg
      className="qr"
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
