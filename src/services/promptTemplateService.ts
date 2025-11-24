// Service for loading and rendering prompt templates with dynamic content and tags.
// Includes simple in-memory caching for render methods to optimize repeated calls.
import fs from 'fs';
import path from 'path';

export class PromptTemplateService {

  private templateBasePath: string;

  // Cache for classification prompts: key is userInput, value is rendered output
  private classificationCache: Map<string, string> = new Map();

  // Cache for tagging prompts: key is content, value is rendered output
  private taggingCache: Map<string, string> = new Map();

  constructor(templateBasePath: string) {
    // templateBasePath should be the directory containing prompt template files
    this.templateBasePath = templateBasePath;
  }

  private resolveTemplatePath(templateFileName: string): string {
    // Resolves the full path to a template file
    return path.join(this.templateBasePath, templateFileName);
  }

  renderClassification(userInput: string): string {
    // Returns a rendered classification prompt, using cache for repeated inputs
    if (this.classificationCache.has(userInput)) {
      return this.classificationCache.get(userInput)!;
    }
    const templatePath = this.resolveTemplatePath("classification.txt");
    var template = fs.readFileSync(templatePath, 'utf-8');
    const output = template.replace(/{{user_input}}/g, userInput);
    this.classificationCache.set(userInput, output);
    return output;
  }

  renderTagging(content: string): string {
    // Returns a rendered tagging prompt, using cache for repeated content
    // Loads tags from allTags.json and formats them for the template
    if (this.taggingCache.has(content)) {
      return this.taggingCache.get(content)!;
    }
    const templatePath = this.resolveTemplatePath("tagging.txt");
    let template = fs.readFileSync(templatePath, 'utf-8');

    // Load tags from allTags.json (relative to prompts directory)
    const tagsPath = path.join(this.templateBasePath, '../samples/allTags.json');
    const tagsData = JSON.parse(fs.readFileSync(tagsPath, 'utf-8'));

    // Format tags: *Description*\ntag1, tag2, ...
    const formattedTags = tagsData.TagGroups.map((group: any) => {
      const desc = `*${group.Description}*`;
      const tags = group.Tags.join(', ');
      return `${desc}\n${tags}`;
    }).join('\n');

    // Replace placeholders in template
    template = template.replace(/{{content}}/g, content);
    template = template.replace(/{{tags}}/g, formattedTags);
    // Store rendered output in cache
    this.taggingCache.set(content, template);

    // TEMPORARY DEBUG LOGGING
    console.debug('[renderTagging] Rendered tagging prompt:', template);

    return template;
  }

  /**
   * Renders the memory_summary.txt template with provided variables.
   */
  renderMemorySearchSummary(variables: { memories: string; mode: string; cluster_type: string; cluster_key: string }): string {
    const templatePath = this.resolveTemplatePath('memory_summary.txt');
    let template = fs.readFileSync(templatePath, 'utf-8');
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`{{${key}}}`, 'g');
      template = template.replace(regex, value);
    }
    return template;
  }
}

// Usage example:
// import path from 'path';
// const service = new PromptTemplateService(path.join(__dirname, '../prompts'));
// const prompt = service.renderClassification('Your input here');
