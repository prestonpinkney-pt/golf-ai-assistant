import { PHASE_PRODUCTION_BUILD } from "next/constants";

type BusinessConfig = {
  id: string;
  slug: string;
  name: string;
  websiteDomain: string;
};

const DEFAULT_BUSINESS_CONFIG: BusinessConfig = {
  id: "b381c0cc-4786-4032-8b22-5143aeaf3e30",
  slug: "primetime-golf",
  name: "Primetime Golf",
  websiteDomain: "primetimegolf.org",
};

export function getBusinessConfig(): BusinessConfig {
  const config = {
    id: process.env.CLOSEOS_BUSINESS_ID ?? DEFAULT_BUSINESS_CONFIG.id,
    slug: process.env.CLOSEOS_BUSINESS_SLUG ?? DEFAULT_BUSINESS_CONFIG.slug,
    name: process.env.CLOSEOS_BUSINESS_NAME ?? DEFAULT_BUSINESS_CONFIG.name,
    websiteDomain:
      process.env.CLOSEOS_WEBSITE_DOMAIN ?? DEFAULT_BUSINESS_CONFIG.websiteDomain,
  };

  assertValidBusinessConfig(config);
  return config;
}

function assertValidBusinessConfig(config: BusinessConfig) {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const domainRegex = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

  if (!uuidRegex.test(config.id)) {
    throw new Error("Invalid CLOSEOS_BUSINESS_ID format");
  }

  if (!slugRegex.test(config.slug)) {
    throw new Error("Invalid CLOSEOS_BUSINESS_SLUG format");
  }

  if (!config.name.trim()) {
    throw new Error("CLOSEOS_BUSINESS_NAME cannot be empty");
  }

  if (!domainRegex.test(config.websiteDomain)) {
    throw new Error("Invalid CLOSEOS_WEBSITE_DOMAIN format");
  }

  // During `next build`, NODE_ENV is production but env may be incomplete locally;
  // require explicit CLOSEOS_* only at production runtime (not the compile/build phase).
  const isProductionRuntime =
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD;

  if (isProductionRuntime) {
    const requiredEnv = [
      "CLOSEOS_BUSINESS_ID",
      "CLOSEOS_BUSINESS_SLUG",
      "CLOSEOS_BUSINESS_NAME",
      "CLOSEOS_WEBSITE_DOMAIN",
    ];

    const missing = requiredEnv.filter((key) => !process.env[key]?.trim());

    if (missing.length > 0) {
      throw new Error(
        `Missing required CloseOS production config: ${missing.join(", ")}`
      );
    }
  }
}

const businessConfig = getBusinessConfig();

export const BUSINESS_ID = businessConfig.id;
export const BUSINESS_SLUG = businessConfig.slug;
export const BUSINESS_NAME = businessConfig.name;
export const WEBSITE_DOMAIN = businessConfig.websiteDomain;
