import { assertEquals } from "@std/assert";
import { splitTextIntoChunks } from "./chunk.ts";

// Default chunk size for testing
const TEST_CHUNK_SIZE = 100;

/**
 * Helper function to log detailed chunk information when a test fails
 */
function logChunks(chunks: string[], message: string) {
  console.log(`\n${message}:`);
  console.log(`Total chunks: ${chunks.length}`);

  chunks.forEach((chunk, idx) => {
    console.log(`\nChunk ${idx + 1} (length: ${chunk.length}):`);
    console.log("-".repeat(40));
    console.log(chunk);
    console.log("-".repeat(40));
  });
}

/**
 * Helper function to verify markdown elements are together in the same chunk
 */
function assertElementsTogether(
  chunks: string[],
  elements: string[],
  errorMessage: string,
): void {
  // Check if there's at least one chunk containing all elements
  const foundTogether = chunks.some((chunk) =>
    elements.every((element) => chunk.includes(element))
  );

  assertEquals(foundTogether, true, errorMessage);
}

Deno.test("splitTextIntoChunks(): basic cases", async (t) => {
  await t.step("returns empty array for empty input", () => {
    assertEquals(splitTextIntoChunks("", TEST_CHUNK_SIZE), []);
    assertEquals(splitTextIntoChunks("   ", TEST_CHUNK_SIZE), []);
  });

  await t.step("keeps short texts as a single chunk", () => {
    const text = "This is a short text that should fit in one chunk.";
    const chunks = splitTextIntoChunks(text, TEST_CHUNK_SIZE);

    try {
      assertEquals(chunks.length, 1);
      assertEquals(chunks[0], text);
    } catch (error) {
      logChunks(chunks, "Short text chunks");
      throw error;
    }
  });
});

Deno.test("splitTextIntoChunks(): paragraph handling", () => {
  const paragraph1 = "This is the first paragraph.";
  const paragraph2 = "This is the second paragraph.";
  const text = `${paragraph1}\n\n${paragraph2}`;

  const chunks = splitTextIntoChunks(text, TEST_CHUNK_SIZE);

  try {
    assertEquals(chunks.length, 1);
    assertEquals(chunks[0], text);
  } catch (error) {
    logChunks(chunks, "Paragraph chunks");
    throw error;
  }
});

Deno.test("splitTextIntoChunks(): preserves markdown structures", async (t) => {
  await t.step("preserves heading structure", () => {
    const headingTest = `# Heading 1

This is some content under heading 1.

## Heading 2

This is content under heading 2.`;
    const chunks = splitTextIntoChunks(headingTest, TEST_CHUNK_SIZE);

    try {
      if (chunks.length === 1 && chunks[0] === headingTest) {
        console.log("Exact match - test passes");
      } else {
        // Check if headings are properly connected to their content
        for (const chunk of chunks) {
          const headingMatches = chunk.match(/^#+\s+.*$/gm);
          if (headingMatches) {
            for (const heading of headingMatches) {
              const headingIndex = chunk.indexOf(heading);
              const afterHeadingRaw = chunk.substring(
                headingIndex + heading.length,
              );

              if (
                afterHeadingRaw.length > 0 &&
                !afterHeadingRaw.trim().startsWith("#")
              ) {
                assertEquals(
                  afterHeadingRaw.startsWith("\n\n"),
                  true,
                  "Headings should be followed by proper spacing",
                );
              }
            }
          }
        }
      }
    } catch (error) {
      logChunks(chunks, "Markdown blocks test - heading");
      throw error;
    }
  });

  await t.step("preserves code blocks", () => {
    const codeBlockTest = `# Code Example

Here is some code:

\`\`\`javascript
function hello() {
  console.log("Hello, world!");
}
\`\`\`

And more text after the code.`;
    const chunks = splitTextIntoChunks(codeBlockTest, TEST_CHUNK_SIZE);

    try {
      let codeBlockFound = false;

      for (const chunk of chunks) {
        if (chunk.includes("```javascript")) {
          // Check if code block start and end are in the same chunk
          assertEquals(
            chunk.includes("```javascript") && chunk.includes("```\n"),
            true,
            "Code block should not be split internally",
          );

          // Verify code block content is preserved
          assertEquals(
            chunk.includes("function hello()"),
            true,
            "Code block content should be preserved",
          );

          codeBlockFound = true;
        }
      }

      assertEquals(
        codeBlockFound,
        true,
        "At least one chunk should contain the complete code block",
      );
    } catch (error) {
      logChunks(chunks, "Markdown blocks test - code block");
      throw error;
    }
  });

  await t.step("preserves lists", () => {
    const listTest = `# Shopping List

- Apples
- Bananas
- Oranges
- Milk

# To-Do List

1. Wake up
2. Exercise
3. Work
4. Sleep`;
    const chunks = splitTextIntoChunks(listTest, TEST_CHUNK_SIZE);

    try {
      // Verify both bullet list and numbered list are preserved
      const bulletListItems = ["- Apples", "- Bananas", "- Oranges", "- Milk"];
      const numberedListItems = [
        "1. Wake up",
        "2. Exercise",
        "3. Work",
        "4. Sleep",
      ];

      assertElementsTogether(
        chunks,
        bulletListItems,
        "Bullet list should not be split",
      );
      assertElementsTogether(
        chunks,
        numberedListItems,
        "Numbered list should not be split",
      );
    } catch (error) {
      logChunks(chunks, "Markdown blocks test - lists");
      throw error;
    }
  });

  await t.step("preserves blockquotes", () => {
    const blockquoteTest = `# Thoughts on AI

> Artificial intelligence is the future.
> It promises to revolutionize many aspects of our lives.
> We must approach it with caution and ethical considerations.

This is some text following the blockquote.`;

    // Use a smaller chunk size to force potential splitting
    const smallChunkSize = 150;
    const chunks = splitTextIntoChunks(blockquoteTest, smallChunkSize);

    try {
      const blockquoteLines = [
        "> Artificial intelligence is the future.",
        "> It promises to revolutionize",
        "> We must approach it",
      ];

      // Verify all blockquote lines stay in the same chunk
      assertElementsTogether(
        chunks,
        blockquoteLines,
        "Blockquote lines should stay together in the same chunk",
      );

      // Additional validation if the entire text fits in one chunk
      if (blockquoteTest.length <= smallChunkSize) {
        assertEquals(chunks.length, 1, "Should be one chunk if size permits");
        assertEquals(
          chunks[0],
          blockquoteTest,
          "Single chunk should contain the full text",
        );
      }
    } catch (error) {
      logChunks(chunks, "Markdown blocks test - blockquote");
      throw error;
    }
  });

  await t.step("does not split ordered list items internally", () => {
    const orderedListTest =
      `# Instructions\n\n1.  First step is quite long and might cause issues if not handled properly. This line is added to make it even longer and more likely to exceed a smaller chunk size.\n2.  Second step is shorter.\n3.  Third step concludes the process.`;

    // Use a small chunk size that might tempt splitting within the first item
    const smallChunkSize = 100;
    const chunks = splitTextIntoChunks(orderedListTest, smallChunkSize);

    try {
      // If the function keeps the whole block together despite size limit
      if (chunks.length === 1) {
        const chunk = chunks[0];

        // Semantic structure validation (instead of exact string comparison)
        assertEquals(
          chunk.includes("# Instructions"),
          true,
          "Output should contain the heading",
        );

        // Verify all list items with their content are included
        assertEquals(
          chunk.match(/1\.\s+First step/i) !== null,
          true,
          "Output should contain the first list item",
        );
        assertEquals(
          chunk.match(/2\.\s+Second step/i) !== null,
          true,
          "Output should contain the second list item",
        );
        assertEquals(
          chunk.match(/3\.\s+Third step/i) !== null,
          true,
          "Output should contain the third list item",
        );

        // Check if the end of the first item is included
        assertEquals(
          chunk.includes("exceed a smaller chunk size"),
          true,
          "Output should contain the end of the first list item content",
        );
      } else {
        // If the function does split, ensure no list item was split internally
        const item1Start = "1. First step is quite long";
        const item1End = "a smaller chunk size.";

        for (const chunk of chunks) {
          // Check if a chunk contains the start but not the end of item 1
          if (chunk.includes(item1Start) && !chunk.includes(item1End)) {
            const currentChunkIndex = chunks.indexOf(chunk);

            if (currentChunkIndex < chunks.length - 1) {
              const nextChunk = chunks[currentChunkIndex + 1];

              // Check if the next chunk starts with the rest of the item
              if (
                !nextChunk.trim().startsWith(
                  item1End.substring(item1End.indexOf("properly")),
                )
              ) {
                throw new Error(
                  `List item 1 appears to be split internally across chunks incorrectly. Chunk ${currentChunkIndex}: ...${
                    chunk.slice(-50)
                  }, Chunk ${currentChunkIndex + 1}: ${
                    nextChunk.slice(0, 50)
                  }...`,
                );
              }
            }
          }
        }

        // Verify at least one chunk contains list content
        const listContentFound = chunks.some((chunk) =>
          chunk.includes("1. First step") ||
          chunk.includes("2. Second step") ||
          chunk.includes("3. Third step")
        );

        assertEquals(
          listContentFound,
          true,
          "List content should be present in the chunks",
        );
      }
    } catch (error) {
      logChunks(chunks, "Markdown blocks test - ordered list internal split");
      throw error;
    }
  });

  await t.step("handles reference-style links across splits", () => {
    const refLinkText = `This is the first part with a [reference link][1].

---

This is the second part, separated by a horizontal rule.

[1]: https://example.com/ "Example Title"`;

    // Use a chunk size that forces a split at the '---'
    const smallChunkSize = 80;
    const chunks = splitTextIntoChunks(refLinkText, smallChunkSize);

    try {
      // Expect split at '---' and inlined links
      assertEquals(chunks.length, 2, "Should split into two chunks");

      assertEquals(
        chunks[0].trim(),
        `This is the first part with a [reference link](https://example.com/ "Example Title").`,
        "First chunk should have the link inlined",
      );

      assertEquals(
        chunks[1].trim(),
        "***\n\nThis is the second part, separated by a horizontal rule.",
        "Second chunk should contain the text after the split",
      );
    } catch (error) {
      logChunks(chunks, "Markdown blocks test - reference links");
      throw error;
    }
  });
});

Deno.test("splitTextIntoChunks(): splitting behavior", async (t) => {
  await t.step("splits large content respecting max size", () => {
    const largeText = "Lorem ipsum dolor sit amet. ".repeat(10);
    assertEquals(largeText.length > TEST_CHUNK_SIZE, true);

    const chunks = splitTextIntoChunks(largeText, TEST_CHUNK_SIZE);

    try {
      assertEquals(chunks.length >= 2, true);

      for (const chunk of chunks) {
        assertEquals(chunk.length <= TEST_CHUNK_SIZE, true);
      }
    } catch (error) {
      logChunks(chunks, "Large content chunks");
      throw error;
    }
  });

  await t.step("handles logical boundaries (paragraphs)", () => {
    const paragraphs = [];
    for (let i = 0; i < 5; i++) {
      paragraphs.push(
        `Paragraph ${i + 1}\n\nThis is the content of paragraph ${i + 1}.`,
      );
    }
    const text = paragraphs.join("\n\n");
    assertEquals(text.length > TEST_CHUNK_SIZE, true);

    const chunks = splitTextIntoChunks(text, TEST_CHUNK_SIZE);

    try {
      assertEquals(chunks.length >= 2, true);

      for (const chunk of chunks) {
        assertEquals(
          chunk.includes("Paragraph") || chunk.includes("This is the content"),
          true,
        );
      }
    } catch (error) {
      logChunks(chunks, "Logical boundaries chunks");
      throw error;
    }
  });
});

Deno.test("splitTextIntoChunks(): splits between lists based on size", () => {
  const text = `# Shopping List

- Apples
- Bananas
- Oranges
- Milk

# To-Do List

1. Wake up
2. Exercise
3. Work
4. Sleep`;

  // Use a small chunk size to force splitting
  const maxChunkSize = 60;
  const chunks = splitTextIntoChunks(text, maxChunkSize);

  console.log("\nList chunks:");
  console.log(`Total chunks: ${chunks.length}`);
  chunks.forEach((chunk, index) => {
    console.log(`\nChunk ${index + 1} (length: ${chunk.length}):`);
    console.log("----------------------------------------");
    console.log(chunk);
    console.log("----------------------------------------");
  });

  // Expect two chunks because the total size exceeds maxChunkSize
  // Split should occur between the two list/heading blocks
  assertEquals(chunks.length, 2, "Should split into two chunks");

  // Use semantic checks instead of exact string comparison
  // First chunk should contain the shopping list
  const chunk1 = chunks[0];
  assertEquals(
    chunk1.includes("# Shopping List"),
    true,
    "First chunk should contain shopping list heading",
  );
  assertEquals(
    chunk1.match(/- Apples/i) !== null,
    true,
    "First chunk should contain apples item",
  );
  assertEquals(
    chunk1.match(/- Bananas/i) !== null,
    true,
    "First chunk should contain bananas item",
  );
  assertEquals(
    chunk1.match(/- Oranges/i) !== null,
    true,
    "First chunk should contain oranges item",
  );
  assertEquals(
    chunk1.match(/- Milk/i) !== null,
    true,
    "First chunk should contain milk item",
  );

  // Second chunk should contain the to-do list
  const chunk2 = chunks[1];
  assertEquals(
    chunk2.includes("# To-Do List"),
    true,
    "Second chunk should contain to-do list heading",
  );
  assertEquals(
    chunk2.match(/1\.\s+Wake up/i) !== null,
    true,
    "Second chunk should contain first to-do item",
  );
  assertEquals(
    chunk2.match(/2\.\s+Exercise/i) !== null,
    true,
    "Second chunk should contain second to-do item",
  );
  assertEquals(
    chunk2.match(/3\.\s+Work/i) !== null,
    true,
    "Second chunk should contain third to-do item",
  );
  assertEquals(
    chunk2.match(/4\.\s+Sleep/i) !== null,
    true,
    "Second chunk should contain fourth to-do item",
  );
});

/**
 * Tests for edge cases in chunking behavior, particularly focusing on
 * documents that should be split into multiple chunks but might be incorrectly
 * returning only one chunk with content truncation.
 */
Deno.test("splitTextIntoChunks(): handles potential truncation issues", async (t) => {
  await t.step(
    "properly splits large document with consistent structure",
    () => {
      // Create a repeating pattern document that should definitely exceed the chunk size
      const repeatedSection =
        "## Section Heading\n\nThis is a paragraph with some content that takes up space. It contains information relevant to the section heading above.\n\n";

      // Create a large document with enough repetitions to force more chunks
      // Repeat 20 times to ensure we have enough content for 15+ chunks at smaller sizes
      const largeDocument = repeatedSection.repeat(20);

      // Calculate the actual chunks
      const chunks = splitTextIntoChunks(largeDocument, TEST_CHUNK_SIZE);

      // For debugging, show the chunks that were created
      logChunks(chunks, "Large repeating document chunks");

      try {
        // With a significantly larger document (20 sections instead of 10)
        // we should get at least 15 chunks with the standard chunk size
        assertEquals(
          chunks.length >= 15,
          true,
          `Document should split into at least 15 chunks based on size (got ${chunks.length})`,
        );

        // Check that the last section is not truncated
        const lastContentPreserved = chunks.some((chunk) =>
          chunk.includes("section heading above")
        );

        assertEquals(
          lastContentPreserved,
          true,
          "Last section content should not be truncated",
        );

        // Verify content is fully preserved when joined
        const joinedContent = chunks.join("\n\n").replace(/\n{3,}/g, "\n\n")
          .trim();
        assertEquals(
          joinedContent.length >= largeDocument.trim().length * 0.9, // Allow for some whitespace reduction
          true,
          "All content should be preserved across chunks",
        );
      } catch (error) {
        // LogChunks is already called above, no need to repeat
        throw error;
      }
    },
  );

  await t.step("handles long paragraph near max chunk size", () => {
    // Create a document with a long paragraph that's just slightly smaller than max chunk size
    // followed by additional paragraphs that should force another chunk
    const longParagraph =
      "This is a very long paragraph that is designed to be almost the size of our chunk limit. " +
      "It contains lots of text to ensure we get close to the limit. ".repeat(
        5,
      );

    const additionalParagraphs =
      "\n\nHere's another paragraph that should appear in the second chunk.\n\n" +
      "And here's a third paragraph with more content.";

    const document = longParagraph + additionalParagraphs;

    const chunks = splitTextIntoChunks(document, TEST_CHUNK_SIZE);

    try {
      // Should be at least 2 chunks
      assertEquals(
        chunks.length >= 2,
        true,
        "Document should split into at least 2 chunks",
      );

      // Check that additional paragraphs weren't truncated
      const additionalContentPreserved = chunks.some((chunk) =>
        chunk.includes("Here's another paragraph") &&
        chunk.includes("And here's a third paragraph")
      );

      assertEquals(
        additionalContentPreserved,
        true,
        "Additional paragraphs should not be truncated",
      );

      // Ensure the content of the first paragraph is preserved somewhere
      const firstParagraphPreserved = chunks.some((chunk) =>
        chunk.includes("This is a very long paragraph")
      );

      assertEquals(
        firstParagraphPreserved,
        true,
        "First paragraph should be preserved",
      );
    } catch (error) {
      logChunks(chunks, "Long paragraph chunks");
      throw error;
    }
  });

  await t.step("preserves content when document ends with a list", () => {
    // Create a document that ends with a list - sometimes lists at the end can be truncated
    const documentWithListAtEnd = `# Important Information

This is a document that contains important information followed by a list at the end.

Here are some key points to remember:

1. First important point with enough text to take some space
2. Second point with additional explanation
3. Third point that's also detailed enough
4. Fourth and final point that shouldn't be truncated

The above points are crucial to understand the document.`;

    // Use a chunk size that might cause the list to be split or truncated
    const smallChunkSize = 200;
    const chunks = splitTextIntoChunks(documentWithListAtEnd, smallChunkSize);

    try {
      // Check that all list items are preserved somewhere in the chunks
      const allListItemsPreserved = [
        "1. First important point",
        "2. Second point",
        "3. Third point",
        "4. Fourth and final point",
      ].every((item) => chunks.some((chunk) => chunk.includes(item)));

      assertEquals(
        allListItemsPreserved,
        true,
        "All list items should be preserved in the chunks",
      );

      // The last list item and concluding sentence should be in the same chunk
      const lastItemAndConclusion = chunks.some((chunk) =>
        chunk.includes("4. Fourth and final point") &&
        chunk.includes("The above points are crucial")
      );

      assertEquals(
        lastItemAndConclusion,
        true,
        "Last list item and conclusion should be in the same chunk",
      );
    } catch (error) {
      logChunks(chunks, "Document with list at end chunks");
      throw error;
    }
  });

  await t.step(
    "handles a document with mixed content types ending with code",
    () => {
      // Create a complex document with different content types ending with code
      const mixedDocument = `# Mixed Content Document

## Introduction
This document contains various content types.

## Text Section
Here is a regular paragraph with text that takes up some space.

## List Section
- Item one with description
- Item two with description
- Item three with description

## Code Section
Here is some code that appears at the end:

\`\`\`typescript
function importantFunction() {
  // This function does important things
  const result = complexCalculation();
  return result;
}

// This code should not be truncated
console.log("End of the document");
\`\`\``;

      const chunks = splitTextIntoChunks(mixedDocument, TEST_CHUNK_SIZE);

      try {
        // Check that the code block at the end is preserved in its entirety
        const codeBlockPreserved = chunks.some((chunk) =>
          chunk.includes("```typescript") &&
          chunk.includes("function importantFunction") &&
          chunk.includes('console.log("End of the document")') &&
          chunk.includes("```")
        );

        assertEquals(
          codeBlockPreserved,
          true,
          "Code block at the end should be preserved in its entirety",
        );

        // Verify all section headings are preserved
        const allSectionsPreserved = [
          "# Mixed Content Document",
          "## Introduction",
          "## Text Section",
          "## List Section",
          "## Code Section",
        ].every((heading) => chunks.some((chunk) => chunk.includes(heading)));

        assertEquals(
          allSectionsPreserved,
          true,
          "All section headings should be preserved",
        );
      } catch (error) {
        logChunks(chunks, "Mixed content document chunks");
        throw error;
      }
    },
  );
});
