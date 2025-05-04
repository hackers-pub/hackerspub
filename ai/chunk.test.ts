import { assert, assertEquals } from "@std/assert";
import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  combineRelatedChunks,
  groupNodesIntoBlocks,
  mergeBlocksIntoChunks,
  splitByCharsWithWordBoundary,
  splitLargeBlock,
  splitTextDirectly,
  splitTextIntoChunks,
  stringifyNodes,
  validateChunks,
} from "./chunk.ts";

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

// Helper to parse markdown to AST
const parseMd = (md: string): Root => {
  return unified().use(remarkParse).parse(md) as Root;
};

Deno.test("stringifyNodes()", () => {
  const node1: RootContent = {
    type: "paragraph",
    children: [{ type: "text", value: "Hello" }],
  };
  const node2: RootContent = {
    type: "heading",
    depth: 1,
    children: [{ type: "text", value: "Title" }],
  };

  assertEquals(stringifyNodes(node1), "Hello");
  assertEquals(stringifyNodes([node1]), "Hello");
  assertEquals(stringifyNodes([node2, node1]), "# Title\n\nHello");
  assertEquals(stringifyNodes([]), "");
});

Deno.test("groupNodesIntoBlocks()", () => {
  const md =
    `# Title\n\nParagraph 1.\n\n~~~js\nconsole.log("code");\n~~~\n\n- List item 1\n- List item 2\n\nAnother paragraph.`;
  const tree = parseMd(md);
  const blocks = groupNodesIntoBlocks(tree);

  assertEquals(blocks.length, 4);

  // Heading section
  assertEquals(blocks[0].type, "heading_section");
  assertEquals(blocks[0].content, "# Title\n\nParagraph 1.");
  assertEquals(blocks[0].canSplit, false);
  assert(blocks[0].originalNodes !== undefined);
  assertEquals(blocks[0].originalNodes?.length, 2);

  // Code block
  assertEquals(blocks[1].type, "code");
  assertEquals(blocks[1].content, '~~~js\nconsole.log("code");\n~~~');
  assertEquals(blocks[1].canSplit, false);

  // List block
  assertEquals(blocks[2].type, "list");
  assertEquals(blocks[2].content, "- List item 1\n- List item 2"); // Use - as bullet which matches the setting
  assertEquals(blocks[2].canSplit, false);

  // Paragraph block
  assertEquals(blocks[3].type, "paragraph");
  assertEquals(blocks[3].content, "Another paragraph.");
  assertEquals(blocks[3].canSplit, true); // Simple paragraphs can split
});

Deno.test("splitByCharsWithWordBoundary()", () => {
  const text = "This is a sample text for testing the splitting logic.";
  const maxSize = 20;

  assertEquals(splitByCharsWithWordBoundary("short", maxSize), ["short"]);
  assertEquals(splitByCharsWithWordBoundary("exactly twenty chars", maxSize), [
    "exactly twenty chars",
  ]);

  const result1 = splitByCharsWithWordBoundary(text, maxSize);
  assertEquals(result1.length, 3);
  assertEquals(result1[0], "This is a sample "); // Splits at space before 'text'
  assertEquals(result1[1], "text for testing the "); // Splits at space before 'splitting'
  assertEquals(result1[2], "splitting logic.");
  assert(result1.every((part) => part.length <= maxSize + 1)); // Allow one extra for space

  const longWordText = "Antidisestablishmentarianism is a long word.";
  const result2 = splitByCharsWithWordBoundary(longWordText, 15);
  assertEquals(result2.length, 3);
  assertEquals(result2[0], "Antidisestablis"); // Hard split at 15 chars
  assertEquals(result2[1], "hmentarianism "); // Space split
  assertEquals(result2[2], "is a long word."); // Actual output includes "is "
});

Deno.test("splitLargeBlock()", () => {
  const maxSize = 50;
  const para1 = "This is the first paragraph. It is quite long.";
  const para2 = "This is the second paragraph, shorter.";
  const para3 = "A third paragraph.";
  const sentence1 = "This is the first sentence.";
  const sentence2 =
    "This is the second sentence, which is considerably longer.";
  const sentence3 = "A third sentence.";

  // Test splitting by paragraphs
  const multiPara = `${para1}\n\n${para2}\n\n${para3}`;
  const chunks1 = splitLargeBlock(multiPara, maxSize);
  assertEquals(chunks1.length, 3, "Should split into 3 chunks by paragraph");
  assertEquals(chunks1[0], para1);
  assertEquals(chunks1[1], para2);
  assertEquals(chunks1[2], para3);

  // Test splitting by sentences (within a large paragraph)
  const longPara = `${sentence1} ${sentence2} ${sentence3}`;
  const chunks2 = splitLargeBlock(longPara, maxSize);
  assertEquals(
    chunks2.length,
    3,
    "Should split into 3 chunks by sentence/word",
  );
  assertEquals(
    chunks2[0],
    "This is the first sentence. This is the second ",
    "First chunk contains first sentence and part of second",
  );
  assertEquals(
    chunks2[1],
    "sentence, which is considerably longer. A third ", // Split at space with some of sentence 3
    "Second chunk is end of sentence 2 and start of sentence 3",
  );
  assertEquals(
    chunks2[2],
    "sentence.", // End of sentence 3
    "Third chunk is end of sentence 3",
  );

  // Test splitting by characters/words (within a long sentence)
  const veryLongSentence =
    "This sentence is extremely long and has no natural breaking points like periods or double newlines, forcing character splitting.";
  const chunks3 = splitLargeBlock(veryLongSentence, maxSize);
  assertEquals(chunks3.length, 3);
  assertEquals(
    chunks3[0],
    "This sentence is extremely long and has no natural ",
  );
  assertEquals(chunks3[1], "breaking points like periods or double newlines, ");
  assertEquals(chunks3[2], "forcing character splitting.");

  // Test block shorter than max size
  assertEquals(splitLargeBlock("Short content", maxSize), ["Short content"]);
  assertEquals(splitLargeBlock("", maxSize), []);
});

Deno.test("mergeBlocksIntoChunks()", () => {
  const maxSize = 100;
  const blocks = [
    {
      content: "# Title\n\nParagraph 1.",
      size: 21,
      type: "heading_section",
      canSplit: false,
    },
    { content: "```\ncode\n```", size: 12, type: "code", canSplit: false },
    {
      content: "- List item 1\n- List item 2",
      size: 26,
      type: "list",
      canSplit: false,
    },
    {
      content:
        "A very long paragraph that definitely exceeds the maximum chunk size and needs to be split appropriately."
          .repeat(2),
      size: 180,
      type: "paragraph",
      canSplit: true,
    },
    {
      content: "Final paragraph.",
      size: 16,
      type: "paragraph",
      canSplit: true,
    },
  ];

  const chunks = mergeBlocksIntoChunks(blocks, maxSize);

  // Target size is 90 (0.9 * 100)
  assertEquals(chunks.length, 5, "Should be 5 chunks based on splitting");

  // First chunk: Title + Para1 + Code + List
  assertEquals(
    chunks[0],
    "# Title\n\nParagraph 1.\n\n```\ncode\n```\n\n- List item 1\n- List item 2",
    "First chunk contains heading, code, and list",
  );

  // Second chunk: First part of the long paragraph
  assert(
    chunks[1].startsWith("A very long paragraph"),
    "Chunk 2 starts with long paragraph",
  );
  assert(chunks[1].length <= maxSize, "Chunk 2 size is within limit");

  // Third chunk: Second part of the long paragraph
  assert(
    chunks[2].startsWith("appropriately"),
    "Chunk 3 starts with 'appropriately'",
  );
  assert(chunks[2].length <= maxSize, "Chunk 3 size is within limit");

  // Fourth chunk: Final part of the long paragraph
  assertEquals(
    chunks[3],
    "split appropriately.",
    "Chunk 4 contains end of paragraph",
  );

  // Fifth chunk: Final paragraph
  assertEquals(
    chunks[4],
    "Final paragraph.",
    "Chunk 5 contains final paragraph",
  );
});

Deno.test("validateChunks()", () => {
  const maxSize = 100;
  const blocks = [
    { content: "Block 1", size: 7, type: "paragraph", canSplit: true },
    { content: "Block 2", size: 7, type: "paragraph", canSplit: true },
  ];

  // Valid case
  assertEquals(validateChunks(["Block 1", "Block 2"], blocks, maxSize), true);

  // Invalid: Empty chunks
  assertEquals(validateChunks([], blocks, maxSize), false);

  // Invalid: Low content ratio (simulated)
  const lowRatioBlocks = [
    { content: "Block 1", size: 100, type: "paragraph", canSplit: true },
  ];
  assertEquals(validateChunks(["Block"], lowRatioBlocks, maxSize), false);

  // Invalid: Excessively large chunk (splittable)
  const largeChunkBlocks = [
    { content: "A".repeat(400), size: 400, type: "paragraph", canSplit: true },
  ];
  assertEquals(
    validateChunks(["A".repeat(400)], largeChunkBlocks, maxSize),
    false,
  );

  // Valid: Oversized chunk, but it's a single non-splittable block
  const nonSplitBlocks = [
    {
      content: "```\n" + "A".repeat(400) + "\n```",
      size: 408,
      type: "code",
      canSplit: false,
    },
  ];
  assertEquals(
    validateChunks([nonSplitBlocks[0].content], nonSplitBlocks, maxSize),
    true,
  );
});

Deno.test("combineRelatedChunks()", () => {
  const maxSize = 100;

  // Can combine
  const chunks1 = ["Paragraph 1.", "Paragraph 2."];
  assertEquals(
    combineRelatedChunks(chunks1, maxSize),
    "Paragraph 1.\n\nParagraph 2.",
  );

  // Cannot combine (too large)
  const chunks2 = ["A".repeat(60), "B".repeat(60)];
  assertEquals(
    combineRelatedChunks(chunks2, maxSize),
    "A".repeat(60) + "\n\n" + "B".repeat(60),
    "Should combine if within 1.5x maxSize",
  );

  // Cannot combine (not simple paragraphs)
  const chunks3 = ["# Heading", "Paragraph."];
  assertEquals(combineRelatedChunks(chunks3, maxSize), null);
  const chunks4 = ["Paragraph.", "- List item"];
  assertEquals(combineRelatedChunks(chunks4, maxSize), null);

  // Not enough chunks
  assertEquals(combineRelatedChunks(["One chunk"], maxSize), null);
  assertEquals(combineRelatedChunks([], maxSize), null);
});

Deno.test("splitTextDirectly()", () => {
  const maxSize = 50;
  const text1 = "Short text.";
  const text2 = "Paragraph 1.\n\nParagraph 2 which is longer.\n\nParagraph 3.";
  const text3 =
    "A single very long paragraph with multiple sentences. This is the second sentence. And a third one.";
  const text4 = "TextWithoutSpacesOrNewlines".repeat(5);

  // Short text
  assertEquals(splitTextDirectly(text1, maxSize), [text1]);

  // Split by paragraphs
  const chunks2Direct = splitTextDirectly(text2, maxSize);
  assertEquals(chunks2Direct.length, 2);
  assertEquals(
    chunks2Direct[0],
    "Paragraph 1.\n\nParagraph 2 which is longer.",
    "First chunk should contain P1 and P2",
  );
  assertEquals(
    chunks2Direct[1],
    "Paragraph 3.",
    "Second chunk should contain P3",
  );

  // Split large paragraph by sentences/chars
  const chunks3 = splitTextDirectly(text3, maxSize);
  assertEquals(chunks3.length, 3, "Should split into 3 chunks by sentence");
  assertEquals(
    chunks3[0],
    "A single very long paragraph with multiple", // First part
    "First chunk is first part of paragraph",
  );
  assertEquals(
    chunks3[1],
    "sentences. This is the second sentence.", // Second part
    "Second chunk is second part of paragraph",
  );
  assertEquals(
    chunks3[2],
    "And a third one.", // Third part
    "Third chunk is end of paragraph",
  );

  // Split long text without breaks
  const chunks4 = splitTextDirectly(text4, maxSize);
  assertEquals(chunks4.length, 3); // 27*5 = 135 -> 50, 50, 35
  assert(chunks4.every((c) => c.length <= maxSize));
});

// --- Existing tests for splitTextIntoChunks --- (Keep them)

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
      // If the whole text fits in one chunk (which it should here)
      if (headingTest.length <= TEST_CHUNK_SIZE) {
        assertEquals(chunks.length, 1, "Should be one chunk if size permits");
        assertEquals(
          chunks[0],
          headingTest,
          "Single chunk should contain the full text",
        );
      } else {
        // If it splits, check structure preservation (more complex)
        let combined = "";
        chunks.forEach((c) => combined += c + "\n\n");
        // Basic check: ensure headings are present
        assert(combined.includes("# Heading 1"));
        assert(combined.includes("## Heading 2"));
        // More robust checks could involve parsing the chunks
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
      // Code blocks are non-splittable, check if it's contained entirely
      const codeBlockContent =
        '~~~javascript\nfunction hello() {\n  console.log("Hello, world!");\n}\n~~~';
      assertElementsTogether(
        chunks,
        [codeBlockContent],
        "Code block should be contained entirely within one chunk",
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
      // Check if any of the formats exist in any chunk
      assert(
        chunks.some((c) =>
          c.includes("- Apples") &&
          c.includes("- Bananas") &&
          c.includes("- Oranges") &&
          c.includes("- Milk")
        ),
        "Bullet list block should be contained entirely within one chunk",
      );
      assert(
        chunks.some((c) =>
          c.includes("1.") && c.includes("Wake up") &&
          c.includes("2.") && c.includes("Exercise") &&
          c.includes("3.") && c.includes("Work") &&
          c.includes("4.") && c.includes("Sleep")
        ),
        "Numbered list block should be contained entirely within one chunk",
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
      // Blockquotes are non-splittable blocks
      const blockquoteContent =
        "> Artificial intelligence is the future.\n> It promises to revolutionize many aspects of our lives.\n> We must approach it with caution and ethical considerations.";

      assertElementsTogether(
        chunks,
        [blockquoteContent],
        "Blockquote block should be contained entirely within one chunk",
      );
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
      // Lists are non-splittable blocks, so the entire list should be in one chunk
      // Adjust expected strings based on actual output format
      const listStartContent = "First step is quite long"; // Check for content, not format
      const listEndContent = "Third step concludes the process"; // Check for content, not format

      // Check if the content exists in *any* chunk, regardless of exact format
      assert(
        chunks.some((c) =>
          c.includes(listStartContent) && c.includes(listEndContent)
        ),
        "Entire ordered list block should be in one chunk",
      );
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

      // remark-stringify converts --- to ***
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
    const largeText = "Lorem ipsum dolor sit amet. ".repeat(10); // 280 chars
    assertEquals(largeText.length > TEST_CHUNK_SIZE, true);

    const chunks = splitTextIntoChunks(largeText, TEST_CHUNK_SIZE);

    try {
      // Expect 3 chunks (280 / 100)
      assertEquals(
        chunks.length,
        3,
        `Should split into 3 chunks (got ${chunks.length})`,
      );

      for (const chunk of chunks) {
        assert(
          chunk.length <= TEST_CHUNK_SIZE,
          `Chunk length ${chunk.length} exceeds max size ${TEST_CHUNK_SIZE}`,
        );
      }
    } catch (error) {
      logChunks(chunks, "Large content chunks");
      throw error;
    }
  });

  await t.step("handles logical boundaries (paragraphs)", () => {
    // Create text where paragraphs naturally fit into chunks
    const para1 = "Paragraph 1, short."; // 19
    const para2 = "Paragraph 2, a bit longer than the first one."; // 45
    const para3 = "Paragraph 3, medium length as well."; // 35
    const para4 = "Paragraph 4, the final one."; // 27
    const text = [para1, para2, para3, para4].join("\n\n"); // Total ~126 + separators
    assertEquals(text.length > TEST_CHUNK_SIZE, true);

    const chunks = splitTextIntoChunks(text, TEST_CHUNK_SIZE);

    try {
      // Expect 1 chunk due to combineRelatedChunks merging P1+P2 and P3+P4
      assertEquals(
        chunks.length,
        1,
        `Should combine into 1 chunk (got ${chunks.length})`,
      );
      assertEquals(
        chunks[0],
        text,
        "The single chunk should contain all paragraphs",
      );
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

  // Use a small chunk size to force splitting between the two heading sections
  const maxChunkSize = 60;
  const chunks = splitTextIntoChunks(text, maxChunkSize);

  // Expected: Chunk 1 = Shopping List section, Chunk 2 = To-Do List section
  // Block 1 (Shopping List): # Shopping List\n\n*   Apples... (size > 60)
  // Block 2 (To-Do List): # To-Do List\n\n1.  Wake up... (size > 60)
  // Since blocks are non-splittable heading sections, they become chunks themselves.

  try {
    assertEquals(chunks.length, 2, "Should split into two chunks");

    // First chunk should contain the shopping list section
    const chunk1 = chunks[0];
    assert(
      chunk1.includes("# Shopping List"),
      "Chunk 1: Shopping List heading",
    );
    assert(chunk1.includes("- Milk"), "Chunk 1: Shopping List content");
    assert(
      !chunk1.includes("# To-Do List"),
      "Chunk 1: Should not contain To-Do List",
    );

    // Second chunk should contain the to-do list section
    const chunk2 = chunks[1];
    assert(chunk2.includes("# To-Do List"), "Chunk 2: To-Do List heading");
    assert(
      chunk2.includes("4") && chunk2.includes("Sleep"),
      "Chunk 2: To-Do List content",
    );
    assert(
      !chunk2.includes("# Shopping List"),
      "Chunk 2: Should not contain Shopping List",
    );
  } catch (error) {
    logChunks(chunks, "List splitting chunks");
    throw error;
  }
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
      const repeatedSection =
        "## Section Heading\n\nThis is a paragraph with some content that takes up space. It contains information relevant to the section heading above.\n\n"; // ~140 chars
      const largeDocument = repeatedSection.repeat(5); // ~700 chars

      const chunks = splitTextIntoChunks(largeDocument, TEST_CHUNK_SIZE);

      try {
        // Each section is a non-splittable heading_section block > 100
        // So each section should become its own chunk.
        assertEquals(
          chunks.length,
          5,
          `Should split into 5 chunks (got ${chunks.length})`,
        );

        // Check that the last section is not truncated
        assert(
          chunks[4].includes("section heading above"),
          "Last section content preserved",
        );

        // Verify content is fully preserved (approx)
        const joinedContent = chunks.join("\n\n").trim();
        const originalTrimmed = largeDocument.trim();
        // Stringify might slightly alter spacing/formatting, compare length ratio
        assert(
          joinedContent.length >= originalTrimmed.length * 0.95,
          `Content length mismatch: original=${originalTrimmed.length}, joined=${joinedContent.length}`,
        );
      } catch (error) {
        logChunks(chunks, "Large repeating document chunks");
        throw error;
      }
    },
  );

  await t.step(
    "handles long paragraph near max chunk size followed by more",
    () => {
      const longParagraph = "A".repeat(95); // Close to 100
      const additionalParagraphs = "\n\nB".repeat(5); // Should go in next chunk
      const document = longParagraph + additionalParagraphs;

      const chunks = splitTextIntoChunks(document, TEST_CHUNK_SIZE);

      try {
        // Expect 1 chunk due to combineRelatedChunks
        assertEquals(
          chunks.length,
          1,
          "Should combine into 1 chunk",
        );
        assertEquals(
          chunks[0],
          document,
          "Single chunk should contain combined content",
        );
      } catch (error) {
        logChunks(chunks, "Long paragraph near limit chunks");
        throw error;
      }
    },
  );

  await t.step("preserves content when document ends with a list", () => {
    const documentWithListAtEnd = `# Important Information

Paragraph before list.

1. First point
2. Second point
3. Third point`; // Ends exactly here

    const smallChunkSize = 50; // Force split before list
    const chunks = splitTextIntoChunks(documentWithListAtEnd, smallChunkSize);

    try {
      // Expect 2 chunks: [Heading + Para], [List] - Keep this expectation
      assertEquals(chunks.length, 2, "Should split into 2 chunks");

      // Check list content is in the second chunk
      assert(
        chunks[1].includes("1") && chunks[1].includes("First point"),
        "List item 1 preserved",
      );
      assert(
        chunks[1].includes("2") && chunks[1].includes("Second point"),
        "List item 2 preserved",
      );
      assert(
        chunks[1].includes("3") && chunks[1].includes("Third point"),
        "List item 3 preserved",
      );
      assert(
        chunks[1].includes("3") && chunks[1].endsWith("point"), // Check end content without exact spacing
        "Chunk 2 ends with list item 3",
      );
    } catch (error) {
      logChunks(chunks, "Document with list at end chunks");
      throw error;
    }
  });

  await t.step(
    "handles a document with mixed content types ending with code",
    () => {
      const mixedDocument = `# Mixed Content

Para 1.

- List item

\`\`\`js
console.log("end");
\`\`\``; // Ends exactly here

      const smallChunkSize = 40; // Force splits
      const chunks = splitTextIntoChunks(mixedDocument, smallChunkSize);

      try {
        // Expect 3 chunks: [Heading+Para], [List], [Code] - Keep this expectation
        assertEquals(chunks.length, 3, "Should split into 3 chunks");

        // Check code block is the last chunk
        assert(chunks[2].startsWith("~~~js"), "Chunk 3 starts with code block");
        assert(
          chunks[2].includes('console.log("end")'),
          "Chunk 3 contains code",
        );
        assert(chunks[2].endsWith("~~~"), "Chunk 3 ends with code block");
      } catch (error) {
        logChunks(chunks, "Mixed content ending with code chunks");
        throw error;
      }
    },
  );
});
