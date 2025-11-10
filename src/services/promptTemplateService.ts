
import fs from 'fs';
import path from 'path';

export class PromptTemplateService {
  private templateBasePath: string;

  constructor(templateBasePath: string) {
    this.templateBasePath = templateBasePath;
  }

  private resolveTemplatePath(templateFileName: string): string {
    return path.join(this.templateBasePath, templateFileName);
  }

  renderClassification(userInput: string): string {
    const templatePath = this.resolveTemplatePath("classification.txt");
    var template = fs.readFileSync(templatePath, 'utf-8');
    return template.replace(/{{user_input}}/g, userInput);
  }

  renderTagging(content: string): string {
    const templatePath = this.resolveTemplatePath("tagging.txt");
    var template = fs.readFileSync(templatePath, 'utf-8');
    return template.replace(/{{content}}/g, content);
  }
}

// Usage example:
// import path from 'path';
// const service = new PromptTemplateService(path.join(__dirname, '../prompts'), 'classification.txt');
// const prompt = service.renderClassification('Your input here');
