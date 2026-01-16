/*
Add Memory is a Raycast extension that allows you to quickly add memories to the 
review queue. The memory will be processed to generate metadata (category, description, 
tags) before being committed to the vector database.
*/
import { ActionPanel, Action, Detail, showToast, Toast } from "@raycast/api";
import { useFetch } from "@raycast/utils";

interface Arguments {
  memory: string;
}

interface ReviewQueueResponse {
  message: string;
  item: {
    id: string;
    Content: string;
    LastUpdated: string;
    Category?: string;
    Description?: string;
    Tags?: string[];
  };
}

export default function Command(props: { arguments: Arguments }) {
  const { memory } = props.arguments;

  // API endpoint configuration from environment variables
  const API_URL = process.env.MEMORY_URL || "http://192.168.7.45:3000/api/review/queue";

  // Validate memory input
  if (!memory || !memory.trim()) {
    return (
      <Detail
        markdown="# No Memory Provided\n\nPlease provide a memory string to add to the review queue."
      />
    );
  }

  // Prepare the request body
  const requestBody = {
    Content: memory.trim(),
  };

  const { isLoading, data, error, revalidate } = useFetch<ReviewQueueResponse>(API_URL, {
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
      title: "Failed to add memory",
      message: error.message,
    });
  }

  // Prepare markdown content
  let markdownContent = "Processing memory...";

  if (error) {
    markdownContent = `# Error\n\nFailed to add memory to the review queue.\n\n**Error:** ${error.message}\n\n**Memory Content:**\n\`\`\`\n${memory}\n\`\`\`\n\n---\n\n*Tip: Make sure the Memory API server is running on ${API_URL}*`;
  } else if (data) {
    const { item } = data;
    const formattedJson = JSON.stringify(data, null, 2);
    
    markdownContent = `# Memory Added Successfully\n\n${data.message}\n\n## Memory Details\n\n**ID:** ${item.id}\n\n**Content:**\n> ${item.Content}\n\n**Category:** ${item.Category || "Not yet categorized"}\n\n**Description:** ${item.Description || "Not yet generated"}\n\n**Tags:** ${item.Tags && item.Tags.length > 0 ? item.Tags.join(", ") : "None"}\n\n**Last Updated:** ${new Date(item.LastUpdated).toLocaleString()}\n\n---\n\n**Full Response:**\n\`\`\`json\n${formattedJson}\n\`\`\``;
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
            title="Copy JSON"
            content={data ? JSON.stringify(data, null, 2) : ""}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="Copy Memory ID"
            content={data?.item?.id || ""}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="Copy Memory Content"
            content={memory}
            shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
          />
        </ActionPanel>
      }
      metadata={
        data && (
          <Detail.Metadata>
            <Detail.Metadata.Label title="Status" text="Success" />
            <Detail.Metadata.Label title="Memory ID" text={data.item.id} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.Label 
              title="Category" 
              text={data.item.Category || "Pending"} 
            />
            <Detail.Metadata.Label 
              title="Tags" 
              text={data.item.Tags && data.item.Tags.length > 0 ? data.item.Tags.join(", ") : "None"} 
            />
            <Detail.Metadata.Separator />
            <Detail.Metadata.Label
              title="Content Length"
              text={`${data.item.Content.length} characters`}
            />
            <Detail.Metadata.Label
              title="Added"
              text={new Date(data.item.LastUpdated).toLocaleString()}
            />
          </Detail.Metadata>
        )
      }
    />
  );
}