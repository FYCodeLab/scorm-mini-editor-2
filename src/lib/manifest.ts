export interface ScormResource {
  identifier: string;
  href: string;
  scormType: string | null;
  files: string[];
}

export interface ScormManifest {
  identifier: string | null;
  version: string | null;
  scormVersion: "1.2" | "2004" | "unknown";
  schema: string | null;
  schemaVersion: string | null;
  orgTitle: string | null;
  orgIdentifier: string | null;
  defaultOrg: string | null;
  items: { identifier: string; identifierref: string | null; title: string }[];
  resources: ScormResource[];
  launchHref: string | null;
  raw: string;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

function textOf(xml: string, tagName: string): string | null {
  const m = xml.match(new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, "i"));
  return m ? m[1].trim() : null;
}

/**
 * Parse imsmanifest.xml with regexes only (no DOMParser dependency, so the
 * same code runs in the browser and in Node tests). This is intentionally
 * conservative: it reads identifiers, titles, resources and the launch file,
 * and never rewrites the manifest.
 */
export function parseManifest(xml: string): ScormManifest {
  const manifestTag = xml.match(/<manifest\b[^>]*>/i)?.[0] ?? "";
  const schema = textOf(xml, "schema");
  const schemaVersion = textOf(xml, "schemaversion");
  let scormVersion: ScormManifest["scormVersion"] = "unknown";
  if (/2004/i.test(schemaVersion ?? "") || /2004/i.test(xml.slice(0, 2000))) scormVersion = "2004";
  else if (/1\.2/.test(schemaVersion ?? "") || /ADL SCORM/i.test(schema ?? "")) scormVersion = "1.2";

  const orgMatch = xml.match(/<organization\b[^>]*>([\s\S]*?)<\/organization>/i);
  const orgTag = xml.match(/<organization\b[^>]*>/i)?.[0] ?? "";
  const orgTitle = orgMatch ? textOf(orgMatch[1], "title") : null;

  const items: ScormManifest["items"] = [];
  if (orgMatch) {
    for (const m of orgMatch[1].matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/gi)) {
      items.push({
        identifier: attr(m[1], "identifier") ?? "",
        identifierref: attr(m[1], "identifierref"),
        title: textOf(m[2], "title") ?? "",
      });
    }
  }

  const resources: ScormResource[] = [];
  for (const m of xml.matchAll(/<resource\b([^>]*)>([\s\S]*?)<\/resource>/gi)) {
    const files: string[] = [];
    for (const f of m[2].matchAll(/<file\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) files.push(f[1]);
    resources.push({
      identifier: attr(m[1], "identifier") ?? "",
      href: attr(m[1], "href") ?? "",
      scormType: attr(m[1], "adlcp:scormtype") ?? attr(m[1], "scormtype"),
      files,
    });
  }

  const defaultOrg = xml.match(/<organizations\b[^>]*default\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
  let launchHref: string | null = null;
  const sco = resources.find((r) => r.scormType === "sco") ?? resources[0];
  if (sco) launchHref = sco.href || sco.files[0] || null;
  if (!launchHref && items.length) {
    const ref = items[0].identifierref;
    const res = resources.find((r) => r.identifier === ref);
    if (res) launchHref = res.href || res.files[0] || null;
  }

  return {
    identifier: attr(manifestTag, "identifier"),
    version: attr(manifestTag, "version"),
    scormVersion,
    schema,
    schemaVersion,
    orgTitle,
    orgIdentifier: attr(orgTag, "identifier"),
    defaultOrg,
    items,
    resources,
    launchHref,
    raw: xml,
  };
}

export function validateManifest(m: ScormManifest, files: string[]): string[] {
  const warnings: string[] = [];
  if (!m.launchHref) warnings.push("No launch file could be found in the manifest.");
  else if (!files.includes(m.launchHref) && !files.includes(decodeURIComponent(m.launchHref))) {
    warnings.push(`Launch file "${m.launchHref}" is listed in the manifest but was not found in the ZIP.`);
  }
  for (const r of m.resources) {
    for (const f of r.files) {
      if (!files.includes(f)) warnings.push(`Manifest lists "${f}" but it is missing from the ZIP.`);
    }
  }
  return warnings;
}
