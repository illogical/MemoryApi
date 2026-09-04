// Service for loading and rendering prompt templates with dynamic content and tags.
// Includes simple in-memory caching for render methods to optimize repeated calls.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { RenderedTaskPrompt } from '../models/ingestionTask';

const PROMPT_VERSIONS = {
  classification: 'transport-v1',
  tagging: 'transport-v1',
  summary: 'transport-v1',
} as const;

export function wrapMemoryContent(content: string): string {
  const escapedContent = content.replace(/<\/memory\s*>/gi, '&lt;/memory&gt;');
  return `<memory>\n${escapedContent}\n</memory>`;
}

export class PromptTemplateService {

  private templateBasePath: string;

  // Cache for classification prompts: key is userInput, value is rendered output
  private classificationCache: Map<string, RenderedTaskPrompt> = new Map();

  // Cache for tagging prompts: key is content, value is rendered output
  private taggingCache: Map<string, RenderedTaskPrompt> = new Map();

  // Cache for tag suggestion prompts: key is content, value is rendered output
  private tagSuggestionCache: Map<string, string> = new Map();

  private validCategoriesCache: string[] | null = null;
  private validTagsCache: string[] | null = null;

  constructor(templateBasePath: string) {
    // templateBasePath should be the directory containing prompt template files
    this.templateBasePath = templateBasePath;
  }

  private resolveTemplatePath(templateFileName: string): string {
    // Resolves the full path to a template file
    return path.join(this.templateBasePath, templateFileName);
  }

  renderClassification(userInput: string): RenderedTaskPrompt {
    // Returns a rendered classification prompt, using cache for repeated inputs
    if (this.classificationCache.has(userInput)) {
      return this.classificationCache.get(userInput)!;
    }
    const templatePath = this.resolveTemplatePath("categorization.txt");
    let template = fs.readFileSync(templatePath, 'utf-8');
    
    // Load categories from allCategories.json (relative to prompts directory)
    const categoriesPath = path.join(this.templateBasePath, '../samples/allCategories.json');
    const categoriesSource = fs.readFileSync(categoriesPath, 'utf-8');
    const categoriesData = JSON.parse(categoriesSource);
    
    // Format categories: - Category1\n- Category2\n...
    const formattedCategories = categoriesData.Categories.map((cat: string) => `- ${cat}`).join('\n');
    
    // Replace placeholders in template
    template = template.replace(/{{categories}}/g, formattedCategories);
    const output: RenderedTaskPrompt = {
      system: template,
      user: wrapMemoryContent(userInput),
      promptId: 'classification',
      promptVersion: PROMPT_VERSIONS.classification,
      taxonomySha256: createHash('sha256').update(categoriesSource).digest('hex'),
    };
    this.classificationCache.set(userInput, output);
    return output;
  }

  renderTagging(content: string): RenderedTaskPrompt {
    // Returns a rendered tagging prompt, using cache for repeated content
    // Loads tags from allTags.json and formats them for the template
    if (this.taggingCache.has(content)) {
      return this.taggingCache.get(content)!;
    }
    const templatePath = this.resolveTemplatePath("tagging.txt");
    let template = fs.readFileSync(templatePath, 'utf-8');

    // Load tags from allTags.json (relative to prompts directory)
    const tagsPath = path.join(this.templateBasePath, '../samples/allTags.json');
    const tagsSource = fs.readFileSync(tagsPath, 'utf-8');
    const tagsData = JSON.parse(tagsSource);

    // Format tags: tag1, tag2, ...
    const formattedTags = tagsData.TagGroups.map((group: any) => {
      const tags = group.Tags.join(', ');
      return `${tags}`;
    }).join('\n');

    // Replace placeholders in template
    template = template.replace(/{{tags}}/g, formattedTags);
    const output: RenderedTaskPrompt = {
      system: template,
      user: wrapMemoryContent(content),
      promptId: 'tagging',
      promptVersion: PROMPT_VERSIONS.tagging,
      taxonomySha256: createHash('sha256').update(tagsSource).digest('hex'),
    };
    this.taggingCache.set(content, output);
    return output;
  }

  /**
   * Renders the memory_summary.txt template with provided content.
   */
  renderMemorySummary(content: string): RenderedTaskPrompt {
    const templatePath = this.resolveTemplatePath('memory_summary.txt');
    const template = fs.readFileSync(templatePath, 'utf-8');
    return {
      system: template,
      user: wrapMemoryContent(content),
      promptId: 'memory-summary',
      promptVersion: PROMPT_VERSIONS.summary,
    };
  }

  /**
   * Renders the aggregation_summary.txt template with provided variables.
   */
  renderMemorySearchSummary(variables: { memories: string; mode: string; cluster_type: string; cluster_key: string }): string {
    const templatePath = this.resolveTemplatePath('aggregation_summary.txt');
    let template = fs.readFileSync(templatePath, 'utf-8');
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`{{${key}}}`, 'g');
      template = template.replace(regex, value);
    }
    return template;
  }

  /**
   * Renders the tag_suggestion.md template with provided content.
   * Injects memory content into the prompt for tag generation.
   */
  renderTagSuggestion(content: string): string {
    // Returns a rendered tag suggestion prompt, using cache for repeated content
    if (this.tagSuggestionCache.has(content)) {
      return this.tagSuggestionCache.get(content)!;
    }
    const templatePath = this.resolveTemplatePath('tag_suggestion.md');
    let template = fs.readFileSync(templatePath, 'utf-8');

        // Load tags from allTags.json (relative to prompts directory)
    const tagsPath = path.join(this.templateBasePath, '../samples/allTags.json');
    const tagsData = JSON.parse(fs.readFileSync(tagsPath, 'utf-8'));

    // Format tags: tag1, tag2, ...
    const formattedTags = tagsData.TagGroups.map((group: any) => {
      const tags = group.Tags.join(', ');
      return `${tags}`;
    }).join('\n');

    // Replace the {content} placeholder with the provided content
    template = template.replace(/{content}/g, content);
    template = template.replace(/{{tags}}/g, formattedTags);

    // Store rendered output in cache
    this.tagSuggestionCache.set(content, template);

    return template;
  }

  /**
   * Renders the entity_extraction.txt template with provided content.
   */
  renderEntityExtraction(content: string): string {
    const templatePath = this.resolveTemplatePath('entity_extraction.txt');
    let template = fs.readFileSync(templatePath, 'utf-8');
    template = template.replace(/{{content}}/g, content);
    return template;
  }

  getValidCategories(): string[] {
    if (this.validCategoriesCache) return this.validCategoriesCache;
    const categoriesPath = path.join(this.templateBasePath, '../samples/allCategories.json');
    const data = JSON.parse(fs.readFileSync(categoriesPath, 'utf-8'));
    this.validCategoriesCache = data.Categories as string[];
    return this.validCategoriesCache;
  }

  getValidTags(): string[] {
    if (this.validTagsCache) return this.validTagsCache;
    const tagsPath = path.join(this.templateBasePath, '../samples/allTags.json');
    const data = JSON.parse(fs.readFileSync(tagsPath, 'utf-8'));
    this.validTagsCache = (data.TagGroups as Array<{ Tags: string[] }>).flatMap(g => g.Tags);
    return this.validTagsCache;
  }
}
