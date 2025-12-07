/*
Search Memories is a Raycast extension that allows you to perform semantic searches 
across your memory database using natural language queries. Results are ranked by 
relevance and display comprehensive metadata including category, tags, and similarity scores.
*/
import { ActionPanel, Action, Detail, showToast, Toast } from "@raycast/api";
import { useFetch } from "@raycast/utils";

interface Arguments {
  query: string;
  category?: string;
  limit?: string;
}

interface MemorySearchResponse {
  query: string;
  count: number;
  memories: Array<{
    id: string;
    Content: string;
    LastUpdated: string;
    Category?: string;
    Description?: string;
    Tags?: string[];
    score?: number;
  }>;
}

export default function Command(props: { arguments: Arguments }) {
  const { query, category, limit } = props.arguments;

  // API endpoint configuration
  const API_URL = "http://localhost:3000/api/memories/search";

  // Validate query input
  if (!query || !query.trim()) {
    return (
      <Detail
        markdown="# No Query Provided\n\nPlease provide a search query to find relevant memories."
      />
    );
  }

  // Prepare the request body
  const requestBody: { query: string; category?: string; limit?: number } = {
    query: query.trim(),
  };

  if (category && category.trim()) {
    requestBody.category = category.trim();
  }

  if (limit && !isNaN(parseInt(limit))) {
    requestBody.limit = parseInt(limit);
  }

  const { isLoading, data, error, revalidate } = useFetch<MemorySearchResponse>(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  // Handle error cases with toast notification
  if (error) {
    showToast({
      style: Toast.Style.Failure,
      title: "Search failed",
      message: error.message,
    });
  }

  // Prepare markdown content
  let markdownContent = "Searching memories...";

  if (error) {
    markdownContent = `# Search Error\n\nFailed to search memories.\n\n**Error:** ${error.message}\n\n**Query:** \`${query}\`\n\n---\n\n*Tip: Make sure the Memory API server is running on ${API_URL}*`;
  } else if (data) {
    const { memories, count } = data;

    if (count === 0) {
      markdownContent = `# No Results Found\n\n**Query:** ${query}\n\nNo memories matched your search. Try:\n- Using different keywords\n- Broadening your search terms\n- Checking if memories exist in the database`;
    } else {
      // Build formatted results
      const resultsMarkdown = memories
        .map((memory, index) => {
          const scorePercent = memory.score ? (memory.score * 100).toFixed(1) : "N/A";
          const tags = memory.Tags && memory.Tags.length > 0 ? memory.Tags.join(", ") : "None";
          const category = memory.Category || "Uncategorized";
          const description = memory.Description || "No description";

          return `## ${index + 1}. ${category} (${scorePercent}% match)\n\n**Content:**\n> ${memory.Content}\n\n**Description:** ${description}\n\n**Tags:** ${tags}\n\n**ID:** \`${memory.id}\`\n\n**Last Updated:** ${new Date(memory.LastUpdated).toLocaleString()}\n\n---`;
        })
        .join("\n\n");

      markdownContent = `# Search Results\n\n**Query:** ${query}\n**Found:** ${count} ${count === 1 ? "memory" : "memories"}${category ? ` in category **${category}**` : ""}\n\n---\n\n${resultsMarkdown}`;
    }
  }

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdownContent}
      actions={
        <ActionPanel>
          <Action
            title="Reload"
            onAction={revalidate}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
          />
          <Action.CopyToClipboard
            title="Copy All Results"
            content={data ? JSON.stringify(data.memories, null, 2) : ""}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="Copy First Memory ID"
            content={data?.memories[0]?.id || ""}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="Copy Query"
            content={query}
            shortcut={{ modifiers: ["cmd", "shift"], key: "q" }}
          />
        </ActionPanel>
      }
      metadata={
        data && data.count > 0 && (
          <Detail.Metadata>
            <Detail.Metadata.Label title="Query" text={query} />
            {category && <Detail.Metadata.Label title="Category Filter" text={category} />}
            <Detail.Metadata.Separator />
            <Detail.Metadata.Label title="Results" text={`${data.count} ${data.count === 1 ? "memory" : "memories"}`} />
            <Detail.Metadata.Label
              title="Top Match Score"
              text={data.memories[0]?.score ? `${(data.memories[0].score * 100).toFixed(1)}%` : "N/A"}
            />
            <Detail.Metadata.Separator />
            <Detail.Metadata.Label
              title="Categories Found"
              text={[...new Set(data.memories.map((m) => m.Category || "Uncategorized"))].join(", ")}
            />
            <Detail.Metadata.Label
              title="Unique Tags"
              text={`${new Set(data.memories.flatMap((m) => m.Tags || [])).size} tags`}
            />
          </Detail.Metadata>
        )
      }
    />
  );
}
