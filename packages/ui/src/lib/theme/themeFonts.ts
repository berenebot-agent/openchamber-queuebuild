import inter400 from '@/assets/fonts/inter/inter-latin-400-normal.woff2?url';
import inter500 from '@/assets/fonts/inter/inter-latin-500-normal.woff2?url';
import inter600 from '@/assets/fonts/inter/inter-latin-600-normal.woff2?url';

interface BundledThemeFont {
  family: string;
  stack: string;
  faces: ReadonlyArray<readonly [weight: number, url: string]>;
}

const INTER: BundledThemeFont = {
  family: 'Inter',
  stack: '"Inter", system-ui, sans-serif',
  faces: [[400, inter400], [500, inter500], [600, inter600]],
};

/** Themes that ship their own UI font. The files are bundled, so nothing is fetched from a CDN. */
const BUNDLED_THEME_FONTS = new Map<string, BundledThemeFont>([
  ['olympus-dark', INTER],
]);

const addedFaces = new Set<string>();

export function getBundledThemeFontStack(themeId: string): string | undefined {
  return BUNDLED_THEME_FONTS.get(themeId)?.stack;
}

export function loadBundledThemeFont(themeId: string): void {
  const font = BUNDLED_THEME_FONTS.get(themeId);
  if (!font) {
    return;
  }
  for (const [weight, url] of font.faces) {
    const key = `${font.family}:${weight}`;
    if (addedFaces.has(key)) continue;
    addedFaces.add(key);
    const face = new FontFace(font.family, `url(${url}) format('woff2')`, { style: 'normal', weight: String(weight), display: 'swap' });
    document.fonts.add(face);
    face.load().catch((error) => {
      addedFaces.delete(key);
      document.fonts.delete(face);
      console.warn(`Failed to load font: ${font.family} ${weight}`, error);
    });
  }
}
