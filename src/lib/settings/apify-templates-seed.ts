/** Seed content for apify_actor_templates (step 6). */
export const APIFY_TEMPLATES_SEED = {
  site: {
    actor_id: "apify/website-content-crawler",
    input: {
      maxCrawlPages: 12,
      maxCrawlDepth: 2,
      crawlerType: "cheerio",
      saveHtml: false,
      saveMarkdown: true,
    },
  },
  tech: {
    actor_id: "tugelbay/website-tech-stack-detector",
    input: {},
  },
  li_posts: {
    actor_id: "harvestapi/linkedin-profile-posts",
    input: { maxPosts: 5 },
  },
} as const;

export const APIFY_TEMPLATES_SEED_META = {
  changed_by: "amir",
  change_note: "v1: site crawl, tech stack, LinkedIn profile posts (step 6)",
};
