import JSZip from "jszip";

/** Synthetic demo SCORM 1.2 package (NOT the SupBiotech course). Used for the
 *  in-app demo and for automated tests, so the public repo never needs a real course. */
export const SAMPLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Sample Course — Photosynthesis Basics</title>
<style>body{font-family:Arial,sans-serif;max-width:720px;margin:2em auto;padding:0 1em;color:#1a3044}h1{color:#004761}.hero{width:100%;max-width:480px}</style>
</head><body>
<h1>Photosynthesis Basics</h1>
<p>Plants turn sunlight, water and carbon dioxide into sugars and oxygen.</p>
<p>Chlorophyll in the leaves captures light energy for this process.</p>
<img class="hero" src="leaf.png" alt="A green leaf">
<p><button onclick="alert('Well done!')">Check understanding</button></p>
<script>var api=null;try{api=window.API||window.parent.API}catch(e){}if(api){try{api.LMSInitialize('');api.LMSSetValue('cmi.core.lesson_status','incomplete');}catch(e){}}</script>
</body></html>`;

export const SAMPLE_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="sample_photosynthesis" version="1.0" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
<metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
<organizations default="ORG"><organization identifier="ORG"><title>Sample Course — Photosynthesis Basics</title>
<item identifier="ITEM1" identifierref="RES1"><title>Photosynthesis Basics</title></item>
</organization></organizations>
<resources><resource identifier="RES1" type="webcontent" adlcp:scormtype="sco" href="index.html">
<file href="index.html"/><file href="leaf.png"/>
</resource></resources>
</manifest>`;

/** A 1x1 green PNG, base64. */
export const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function buildSampleZip(): Promise<Blob> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", SAMPLE_MANIFEST);
  zip.file("index.html", SAMPLE_HTML);
  zip.file("leaf.png", base64ToBlob(SAMPLE_PNG_BASE64, "image/png"));
  return zip.generateAsync({ type: "blob" });
}
