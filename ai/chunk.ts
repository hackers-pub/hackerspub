import type { Paragraph, Root, RootContent } from "mdast";
import remarkInlineLinks from "remark-inline-links";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

/**
 * Represents a semantic block of Markdown content.
 */
interface MarkdownBlock {
  content: string; // The Markdown string content of the block
  size: number; // Character length of the content
  type: string; // Type of the primary node in the block (e.g., 'paragraph', 'heading')
  canSplit: boolean; // Whether this block type can be split if it exceeds max size
  originalNodes?: RootContent[]; // Store original nodes for complex types like heading_section
}

// Helper function to stringify mdast nodes to Markdown
function stringifyNodes(nodes: RootContent[] | RootContent): string {
  // Ensure the node passed to stringify is always a Root node.
  const rootNode: Root = Array.isArray(nodes)
    ? { type: "root", children: nodes }
    : { type: "root", children: [nodes] }; // Wrap single node in Root

  // Pass the guaranteed Root node to stringify
  const markdownString = unified()
    .use(remarkStringify)
    .data("settings", {
      listItemIndent: "one",
      bullet: "-",
      rule: "*",
      emphasis: "*",
    })
    .stringify(rootNode);

  // Normalize line endings to LF (\n) and then trim
  return markdownString.replace(/\r\n/g, "\n").trim();
}

/**
 * Groups AST nodes into semantic blocks.
 * @param tree The mdast tree.
 * @returns An array of MarkdownBlock objects.
 */
function groupNodesIntoBlocks(tree: Root): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let currentBlockNodes: RootContent[] = [];
  let currentBlockType: string | null = null;
  let _currentHeadingLevel: number | null = null; // Lint fix: Add underscore

  // Helper to finalize the current block being built
  function finalizeBlock(forceCanSplit?: boolean) { // forceCanSplit is kept for potential future use
    if (currentBlockNodes.length > 0 && currentBlockType) {
      const content = stringifyNodes(currentBlockNodes);
      if (content) {
        let canSplitBlock = false; // Default to non-splittable
        let nodesToStore: RootContent[] | undefined = undefined;

        // Determine splittability based on block type and content
        if (currentBlockType === "paragraph") {
          // Check for complex inline elements
          let containsComplexInline = false;
          if (
            currentBlockNodes.length > 0 &&
            currentBlockNodes[0].type === "paragraph"
          ) {
            const paragraphNode = currentBlockNodes[0] as Paragraph;
            if (paragraphNode.children) {
              for (const child of paragraphNode.children) {
                if (
                  child.type === "link" || child.type === "image" ||
                  child.type === "html" ||
                  child.type === "linkReference" ||
                  child.type === "imageReference"
                ) {
                  containsComplexInline = true;
                  break;
                }
              }
            }
          }
          canSplitBlock = !containsComplexInline;
        } else if (currentBlockType === "heading_section") {
          // Heading sections themselves are not splittable by default
          // Splitting happens *within* them in mergeBlocksIntoChunks if needed
          canSplitBlock = false; // Reverted back to false
          nodesToStore = [...currentBlockNodes]; // Store original nodes for heading sections
        }
        // Other types (code, list, blockquote, etc.) remain non-splittable by default

        // Apply forceCanSplit override if provided (rarely needed now)
        if (forceCanSplit !== undefined) {
          canSplitBlock = forceCanSplit;
        }

        blocks.push({
          content: content,
          size: content.length,
          type: currentBlockType,
          canSplit: canSplitBlock,
          originalNodes: nodesToStore, // Add original nodes if stored
        });
      }
      currentBlockNodes = [];
      currentBlockType = null;
    }
  }

  // Iterate through top-level nodes in the AST
  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i];

    if (node.type === "definition") continue;

    if (node.type === "heading") {
      finalizeBlock();
      const headingLevel = node.depth;
      currentBlockNodes.push(node);
      currentBlockType = "heading_section";
      _currentHeadingLevel = headingLevel; // Lint fix: Use underscored variable

      let j = i + 1;
      while (j < tree.children.length) {
        const nextNode = tree.children[j];
        if (nextNode.type === "heading" && nextNode.depth <= headingLevel) {
          break;
        }
        if (nextNode.type !== "definition") {
          currentBlockNodes.push(nextNode);
        }
        j++;
      }
      // Finalize heading section - let finalizeBlock determine splittability (now false)
      finalizeBlock();
      i = j - 1;
      _currentHeadingLevel = null; // Lint fix: Use underscored variable
    } else if (
      node.type === "code" || node.type === "list" ||
      node.type === "blockquote" ||
      node.type === "thematicBreak" || node.type === "html" ||
      node.type === "table"
    ) {
      finalizeBlock();
      currentBlockNodes.push(node);
      currentBlockType = node.type;
      // Finalize these block types as non-splittable
      finalizeBlock(false); // Explicitly false
    } else if (node.type === "paragraph") {
      finalizeBlock();
      currentBlockNodes.push(node);
      currentBlockType = node.type;
      // Let finalizeBlock determine splittability based on content
      finalizeBlock();
    } else { // Handle any other unexpected top-level node types
      finalizeBlock();
      currentBlockNodes.push(node);
      currentBlockType = node.type;
      // Assume unknown types are not splittable
      finalizeBlock(false); // Explicitly false
    }
  }

  // Finalize any remaining block
  finalizeBlock(); // Let finalizeBlock determine splittability if it's a paragraph

  return blocks;
}

// Helper function to split by characters, trying word boundaries
function splitByCharsWithWordBoundary(text: string, maxSize: number): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      parts.push(remaining);
      break;
    }
    const splitIndex = maxSize;
    const lastSpace = remaining.lastIndexOf(" ", splitIndex);
    // Use space if it's reasonably close to the end (e.g., > 50% of maxSize)
    // and not right at the beginning.
    if (lastSpace > maxSize * 0.5 && lastSpace > 0) {
      // Find the actual index to slice at (after the space)
      const sliceIndex = lastSpace + 1;
      parts.push(remaining.substring(0, sliceIndex).trimEnd());
      remaining = remaining.substring(sliceIndex).trimStart();
    } else {
      // If no good space found, just split at maxSize
      parts.push(remaining.substring(0, maxSize));
      remaining = remaining.substring(maxSize).trimStart(); // trimStart just in case
    }
  }
  return parts.filter((part) => part.length > 0);
}

/**
 * Splits a long block (represented as a Markdown string) into smaller parts.
 * Tries to split by paragraphs, sentences, then words/characters.
 * @param blockContent The Markdown content of the block.
 * @param maxChunkSize The maximum size for each part.
 * @returns An array of smaller Markdown strings.
 */
function splitLargeBlock(blockContent: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  const trimmedBlock = blockContent.trim(); // Trim input initially
  if (!trimmedBlock || trimmedBlock.length <= maxChunkSize) {
    return trimmedBlock ? [trimmedBlock] : [];
  }

  // 1. Split by double newlines (paragraphs)
  const paragraphs = trimmedBlock.split(/\n\s*\n/);
  if (paragraphs.length > 1) {
    let currentChunk = "";
    for (const paragraph of paragraphs) {
      const trimmedPara = paragraph.trim();
      if (!trimmedPara) continue;

      if (trimmedPara.length > maxChunkSize) {
        // Paragraph too large, add current chunk and split the large para
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = "";
        // Recursively split the large paragraph
        const subChunks = splitLargeBlock(trimmedPara, maxChunkSize);
        chunks.push(...subChunks);
      } else if (
        currentChunk.length + (currentChunk ? 2 : 0) + trimmedPara.length <=
          maxChunkSize
      ) {
        // Fits in current chunk
        currentChunk += (currentChunk ? "\n\n" : "") + trimmedPara;
      } else {
        // Doesn't fit, start new chunk
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = trimmedPara;
      }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks.filter((chunk) => chunk.length > 0);
  }

  // 2. No paragraphs, try splitting by sentences
  // Regex aims to keep delimiter with the sentence. Handles ., !, ?, \n
  const sentences = trimmedBlock.match(
    /[^.!?\n]+(?:[.!?](?!(?:\s*[a-z0-9]))|\n|\s*$)+/gi,
  ) || [];
  if (sentences.length > 1) {
    let currentChunk = "";
    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) continue;
      const separator = currentChunk ? " " : ""; // Space between sentences

      if (trimmedSentence.length > maxChunkSize) {
        // Sentence too large, add current chunk and split the large sentence
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = "";
        // Split by characters/words using helper
        chunks.push(
          ...splitByCharsWithWordBoundary(trimmedSentence, maxChunkSize),
        );
      } else if (
        currentChunk.length + separator.length + trimmedSentence.length <=
          maxChunkSize
      ) {
        // Fits in current chunk
        currentChunk += separator + trimmedSentence;
      } else {
        // Doesn't fit, start new chunk
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = trimmedSentence;
      }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks.filter((chunk) => chunk.length > 0);
  }

  // 3. No paragraphs or sentences, split by characters/words using helper
  return splitByCharsWithWordBoundary(trimmedBlock, maxChunkSize);
}

/**
 * Merges Markdown blocks into chunks respecting the maximum size.
 * @param blocks Array of MarkdownBlock objects.
 * @param maxChunkSize Maximum size of each chunk.
 * @returns Array of Markdown strings (chunks).
 */
function mergeBlocksIntoChunks(
  blocks: MarkdownBlock[],
  maxChunkSize: number,
): string[] {
  const chunks: string[] = [];
  let currentChunkContent = "";

  // Decrease target size slightly to leave room for related content
  const targetChunkSize = Math.floor(maxChunkSize * 0.9);

  // Process blocks sequentially
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (!block.content.trim()) continue;

    const separator = currentChunkContent ? "\n\n" : "";
    const combinedSize = currentChunkContent.length + separator.length +
      block.content.length;

    // Case 1: Block itself exceeds max chunk size
    if (block.content.length > maxChunkSize) {
      // First finalize current chunk if it exists
      if (currentChunkContent) {
        chunks.push(currentChunkContent);
        currentChunkContent = "";
      }

      // For splittable blocks, divide them further
      if (block.canSplit) {
        const splitParts = splitLargeBlock(block.content, maxChunkSize);
        chunks.push(...splitParts.filter((part) => part.length > 0));
      } else {
        // Non-splittable blocks go in as they are, even if oversized
        chunks.push(block.content);
      }
      continue;
    }

    // Case 2: Block fits in current chunk
    if (combinedSize <= targetChunkSize) {
      currentChunkContent += separator + block.content;
      continue;
    }

    // Case 3: Block doesn't fit - finish current chunk and start a new one
    if (currentChunkContent) {
      chunks.push(currentChunkContent);
    }
    currentChunkContent = block.content;
  }

  // Add the final chunk if any content remains
  if (currentChunkContent) {
    chunks.push(currentChunkContent);
  }

  return chunks;
}

/**
 * Splits text into meaningful chunks using Markdown AST.
 * Preserves Markdown structure and inlines reference links.
 * @param text The input Markdown text.
 * @param maxChunkSize The target maximum size for each chunk.
 * @returns An array of Markdown strings representing the chunks.
 */
export function splitTextIntoChunks(
  text: string,
  maxChunkSize: number,
): string[] {
  // Handle empty input case
  const trimmedText = text.trim();
  if (!trimmedText) return [];

  try {
    // Process the Markdown text
    const processor = unified()
      .use(remarkParse)
      .use(remarkInlineLinks);

    const tree = processor.parse(trimmedText);
    const treeWithInlinedLinks = processor.runSync(tree) as Root;

    // If the text is small enough, return it as a single chunk
    const fullProcessedText = stringifyNodes(treeWithInlinedLinks.children);
    if (fullProcessedText.length <= maxChunkSize) {
      return fullProcessedText ? [fullProcessedText] : [];
    }

    // Group AST nodes into semantic blocks
    const blocks = groupNodesIntoBlocks(treeWithInlinedLinks);

    // Merge blocks into chunks
    const chunks = mergeBlocksIntoChunks(blocks, maxChunkSize);

    // Special case for related paragraphs
    if (chunks.length >= 2) {
      const lastTwoChunks = combineRelatedChunks(chunks, maxChunkSize);
      if (lastTwoChunks) {
        chunks.splice(chunks.length - 2, 2, lastTwoChunks);
      }
    }

    if (validateChunks(chunks, blocks, maxChunkSize)) {
      return chunks; // postProcessChunks 함수 호출 제거
    }

    return splitTextDirectly(trimmedText, maxChunkSize);
  } catch {
    return splitTextDirectly(trimmedText, maxChunkSize);
  }
}

/**
 * Validates the quality of chunks and determines if fallback is needed.
 * @param chunks The generated chunks.
 * @param blocks The original markdown blocks.
 * @param maxChunkSize The maximum chunk size.
 * @returns True if chunks are valid, false if fallback is needed.
 */
function validateChunks(
  chunks: string[],
  blocks: MarkdownBlock[],
  maxChunkSize: number,
): boolean {
  if (chunks.length === 0) return false;

  // Calculate content preservation ratio
  const totalInputSize = blocks.reduce((sum, block) => sum + block.size, 0);
  const totalOutputSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const contentLossRatio = totalInputSize > 0
    ? totalOutputSize / totalInputSize
    : 1;

  // Check if any chunk is excessively large (excluding non-splittable blocks)
  const excessivelyLargeChunkExists = chunks.some((chunk, index) => {
    // Find if this chunk contains only a single non-splittable block
    let chunkStartIndex = 0;
    for (let i = 0; i < index; i++) {
      chunkStartIndex += chunks[i].length;
    }
    const chunkEndIndex = chunkStartIndex + chunk.length;

    let currentBlockStart = 0;
    let isSingleNonSplittableBlock = false;
    let blockCountInChunk = 0;

    for (const block of blocks) {
      const blockEnd = currentBlockStart + block.size;
      if (blockEnd > chunkStartIndex && currentBlockStart < chunkEndIndex) {
        blockCountInChunk++;
        if (!block.canSplit) {
          isSingleNonSplittableBlock = true;
        } else {
          isSingleNonSplittableBlock = false;
          break;
        }
      }
      currentBlockStart = blockEnd + 2; // Account for potential separator
      if (currentBlockStart >= chunkEndIndex) break;
    }

    // Only flag if not a single non-splittable block
    if (blockCountInChunk === 1 && isSingleNonSplittableBlock) {
      return false;
    }

    return chunk.length > maxChunkSize * 3.0;
  });

  // Determine if fallback is needed
  return contentLossRatio >= 0.85 && !excessivelyLargeChunkExists;
}

/**
 * Try to combine the last chunks if they contain related content
 * (like paragraphs that should be kept together).
 */
function combineRelatedChunks(
  chunks: string[],
  maxChunkSize: number,
): string | null {
  if (chunks.length < 2) return null;

  const lastChunk = chunks[chunks.length - 1];
  const secondLastChunk = chunks[chunks.length - 2];

  // Check if both chunks are paragraphs (no headings or other structures)
  const lastIsSimpleParagraph = !lastChunk.match(
    /^#+\s|^```|^>|^-\s|^\d+\.\s/m,
  );
  const secondIsSimpleParagraph = !secondLastChunk.match(
    /^#+\s|^```|^>|^-\s|^\d+\.\s/m,
  );

  if (lastIsSimpleParagraph && secondIsSimpleParagraph) {
    const combined = secondLastChunk + "\n\n" + lastChunk;

    // If combined size is reasonable, merge them
    // We use a higher threshold (1.5x) for paragraph combinations
    if (combined.length <= maxChunkSize * 1.5) {
      return combined;
    }
  }

  return null;
}

/**
 * Fallback chunking method that directly splits text without using AST.
 * Tries to respect paragraph boundaries, lists, and other semantics.
 */
function splitTextDirectly(text: string, maxChunkSize: number): string[] {
  // If text is small enough, return as a single chunk
  if (text.length <= maxChunkSize) {
    return [text];
  }

  // First try to split by double newlines (paragraphs)
  const paragraphs = text.split(/\n\s*\n/);

  // If we have multiple paragraphs, group them into chunks
  if (paragraphs.length > 1) {
    const chunks: string[] = [];
    let currentChunk = "";

    for (const paragraph of paragraphs) {
      const trimmedPara = paragraph.trim();
      if (!trimmedPara) continue;

      // If this paragraph alone exceeds max size, split it further
      if (trimmedPara.length > maxChunkSize) {
        // Add current chunk if it exists
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = "";
        }

        // Split large paragraph
        let remaining = trimmedPara;
        while (remaining.length > 0) {
          // Try to find a sentence boundary
          let splitIndex = maxChunkSize;
          if (remaining.length > maxChunkSize) {
            const possibleSplit = remaining.substring(0, maxChunkSize)
              .lastIndexOf(". ");
            if (possibleSplit > maxChunkSize * 0.5) {
              splitIndex = possibleSplit + 1; // Include the period
            }
          } else {
            splitIndex = remaining.length;
          }

          chunks.push(remaining.substring(0, splitIndex).trim());
          remaining = remaining.substring(splitIndex).trim();
        }
      } else if (
        currentChunk.length + (currentChunk ? 2 : 0) + trimmedPara.length <=
          maxChunkSize
      ) {
        // Paragraph fits in current chunk
        if (currentChunk) currentChunk += "\n\n";
        currentChunk += trimmedPara;
      } else {
        // Start a new chunk
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = trimmedPara;
      }
    }

    // Add final chunk
    if (currentChunk) chunks.push(currentChunk);

    return chunks;
  }

  // If we can't split by paragraphs, split by maxChunkSize with some care for sentence boundaries
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    // Try to find a sentence boundary near maxChunkSize
    let splitIndex = maxChunkSize;
    const possibleSplit = remaining.substring(0, maxChunkSize).lastIndexOf(
      ". ",
    );

    if (possibleSplit > maxChunkSize * 0.5) {
      splitIndex = possibleSplit + 1; // Include the period
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}
