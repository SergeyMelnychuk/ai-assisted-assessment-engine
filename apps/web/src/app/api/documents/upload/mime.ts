/**
 * MIME allow-list check — runs *before* we touch storage. Keeps obvious
 * garbage out of MinIO. Individual ingest workers apply tighter checks
 * downstream (PDF / DOCX magic bytes, archive safety gates, etc.).
 *
 * We accept the empty / missing MIME case (some browsers send "" for
 * unknown types) and let the detector classify it downstream; the
 * rejection path is reserved for actively-wrong types like
 * `image/jpeg` on a .zip.
 */
export function isAcceptableUploadMime(
  mime: string | undefined | null,
): boolean {
  if (!mime) return true; // defer to downstream detectors
  const allow = [
    /^text\//,
    /^application\/pdf$/,
    /^application\/zip$/,
    /^application\/gzip$/,
    /^application\/x-tar$/,
    /^application\/x-gzip$/,
    /^application\/vnd\.openxmlformats-officedocument\./,
    /^application\/msword$/,
    /^application\/json$/,
    /^application\/xml$/,
    /^application\/(?:x-)?yaml$/,
    /^application\/octet-stream$/,
    /^image\/png$/,
    /^image\/jpeg$/,
    /^image\/svg\+xml$/,
  ];
  return allow.some((rx) => rx.test(mime));
}
