// The Explorer documentation site (VitePress): `npm run docs:dev`, `npm run docs:build` (into docs/.vitepress/dist,
// failing on a dead link), `npm run docs:preview`. Published to GitHub Pages once the repository is public
// (upcoming-changes.md, "Documentation site"). Screenshots show Explorer's interface only, never a model or a place.
import { defineConfig } from "vitepress";

const repo = "https://github.com/WinuxNomacs/webodm-explorer";

export default defineConfig({
  title: "Explorer",
  description: "Browse and share a WebODM project's maps and 3D models, streamed, as a WebODM plugin.",
  base: "/webodm-explorer/",
  cleanUrls: true,
  lastUpdated: false,
  // The setup script is a file in docs/public, not a page
  ignoreDeadLinks: [/^\/webodm-explorer\/linode\/setup\.sh$/],
  themeConfig: {
    nav: [
      { text: "Getting Started", link: "/getting-started" },
      { text: "Guides", link: "/guide/projects" },
      { text: "Hosting", link: "/hosting/linode" },
      { text: "Developing", link: "/developing" },
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "What Is Explorer", link: "/" },
          { text: "Getting Started", link: "/getting-started" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Explorer's Home", link: "/guide/projects" },
          { text: "A Project's Page", link: "/guide/project" },
          { text: "Map and 3D Viewers", link: "/guide/viewers" },
          { text: "Sharing", link: "/guide/sharing" },
          { text: "Administration", link: "/guide/administration" },
        ],
      },
      {
        text: "Hosting",
        items: [{ text: "Hosting on Linode", link: "/hosting/linode" }],
      },
      {
        text: "More",
        items: [{ text: "Developing", link: "/developing" }],
      },
    ],
    socialLinks: [{ icon: "github", link: repo }],
    search: { provider: "local" },
    footer: { message: "AGPL-3.0. Not part of WebODM." },
  },
});
