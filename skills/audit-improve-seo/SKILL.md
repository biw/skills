---
name: audit-improve-seo
description: Audit and improve a web codebase's technical and on-page SEO. Use for metadata, structured data, sitemaps, robots, canonicals, semantic markup, indexability, and @vercel/og or Satori social images.
---

# Audit and Improve SEO

Improve the repository rather than only producing recommendations. Preserve the application's routing, design system, and content model.

## Inspect Before Changing

1. Identify the framework, rendering model, route/page inventory, deployment target, public base URL, locales, CMS/content sources, and existing metadata or image-generation code.
2. Find indexable page types and their stable identity: marketing pages, articles, docs, products, category/listing pages, and paginated or filtered views. Exclude authenticated, personalized, search-result, duplicate, preview, and utility routes from indexing unless the product deliberately supports them.
3. Audit the rendered output and source for title/description coverage, canonical URLs, robots directives, sitemap, `robots.txt`, Open Graph/Twitter metadata, heading structure, semantic landmarks, internal links, image alt text, language declarations, structured data, and avoidable crawl or performance blockers.

## Implement Deliberately

- Centralize metadata defaults and per-page overrides in the framework's native metadata mechanism. Use accurate, unique titles and descriptions derived from real content; do not invent keywords, duplicate boilerplate, or add irrelevant schema.
- Generate absolute canonicals and social-image URLs from the configured production origin. Handle trailing slashes, locales, pagination, and query parameters consistently.
- Add or repair `robots.txt` and a sitemap containing only canonical, indexable URLs. Include meaningful modification dates when the content model provides them.
- Add JSON-LD only where it truthfully represents the page (for example `Organization`, `WebSite`, `Article`, `BreadcrumbList`, `Product`, or `FAQPage`). Keep it synchronized with visible content and validate its JSON.
- Improve meaningful document structure, headings, link text, alt text, and crawlable navigation without changing product copy or visual behavior gratuitously.

## Social Images

Use `@vercel/og` or Satori to create 1200×630 social images for every indexable page type. Reuse the project's supported runtime, fonts, assets, and image route conventions; do not introduce an incompatible edge runtime or duplicate generator.

Choose generation per page type:

- **Static:** Generate and commit/build assets for a small, stable set of evergreen pages whose copy rarely changes. Reference the page-specific static asset in metadata.
- **Dynamic:** Add a route-based image endpoint for content-backed or numerous pages where the title, author, date, category, or hero image varies. Sanitize and length-limit route data, load fonts/assets reliably, set an appropriate cache policy, and give every image deterministic output for its canonical URL.
- **No image:** Do not expose personalized, private, unpublished, or noindex content merely to create an OG image. Use a safe shared fallback only when that route may legitimately be shared.

Ensure generated images remain legible with long titles, have adequate contrast, include the appropriate brand treatment, and do not depend on browser-only CSS. Prefer shared rendering primitives so new page types cannot silently omit an image.

## Verify

1. Run the repository's formatter, typecheck, tests, and production build.
2. Inspect representative rendered metadata for the homepage, one page of each indexable content type, a pagination/filter edge case, and a noindex/private route.
3. Confirm sitemap and robots URLs resolve correctly, canonical URLs are absolute and singular, JSON-LD is valid, and each public social-image URL returns a valid image with its intended cache headers.
4. Summarize implemented changes, remaining content decisions that need an owner, and any routes intentionally excluded from indexing or OG-image generation.
