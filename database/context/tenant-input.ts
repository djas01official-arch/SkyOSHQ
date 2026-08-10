export class TenantInputValidationError extends Error {}

export function normalizeTenantName(value: string, label: string): string {
  const name = value.trim().replace(/\s+/g, ' ');

  if (name.length < 1 || name.length > 120) {
    throw new TenantInputValidationError(
      `${label} names must contain between 1 and 120 characters.`,
    );
  }

  return name;
}

export function normalizeTenantSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length < 1 || slug.length > 48) {
    throw new TenantInputValidationError(
      'Slugs must normalize to between 1 and 48 lowercase letters, numbers, or hyphens.',
    );
  }

  return slug;
}
