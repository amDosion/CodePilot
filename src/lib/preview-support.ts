export type RenderedPreviewKind = 'markdown' | 'html';

export function getRenderedPreviewKind(
  filePath: string,
  language?: string | null,
): RenderedPreviewKind | null {
  const normalizedPath = filePath.toLowerCase();
  const normalizedLanguage = (language || '').trim().toLowerCase();

  if (normalizedPath.endsWith('.html') || normalizedPath.endsWith('.htm')) {
    return 'html';
  }

  if (
    normalizedLanguage === 'markdown'
    || normalizedPath.endsWith('.md')
    || normalizedPath.endsWith('.mdx')
  ) {
    return 'markdown';
  }

  return null;
}
