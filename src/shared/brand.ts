/**
 * The product's name, description, credit and support contact, in one place. The build writes them into
 * manifest.json (name, short_name, description, the toolbar button's title) and the pages' titles; the
 * version comes from package.json. Renaming the product is a change to this file.
 */
export const BRAND = {
  /** At most 45 characters (Microsoft Edge Add-ons' limit). */
  name: "Full Window, Not Screen: Video Sizer",
  /** The manifest's short_name: at most 12 characters, as Chrome recommends. */
  shortName: "Full Window",
  /** At most 132 characters (the manifest and the stores' short description). */
  description: "Keeps a video's fullscreen inside the tab, at a size you choose. The site's own player controls keep working.",
  credit: "Made by Avor Forge LLC",
  /** The support contact shown in the store listings, the privacy policy and the product page. */
  support: {
    email: "inquiries@avorforge.com",
    url: "https://avorforge.com/",
  },
} as const;
