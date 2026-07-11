import assert from "node:assert";
import test from "node:test";
import { addHeaderAnchorLinks } from "./header-anchor.ts";

interface FakeAnchor {
  className: string;
  parentElement: ReturnType<typeof createHeading> | null;
  title: string;
  attributes: Map<string, string>;
  remove(): void;
  setAttribute(name: string, value: string): void;
}

function createHeading(id: string) {
  const children: FakeAnchor[] = [];
  return {
    id,
    querySelector(selector: string) {
      return children.find((child) =>
        child.className === "header-anchor" &&
        (!selector.includes("data-hackerspub-generated") ||
          child.attributes.has("data-hackerspub-generated"))
      ) ?? null;
    },
    appendChild(child: FakeAnchor) {
      child.parentElement?.children.splice(
        child.parentElement.children.indexOf(child),
        1,
      );
      children.push(child);
      child.parentElement = this;
      return child;
    },
    children,
  };
}

function createDocument(
  headings: ReturnType<typeof createHeading>[],
  allIdElements: { id: string }[] = headings,
) {
  return {
    querySelectorAll: (selector: string) => {
      if (selector === "[id]") return allIdElements;
      if (selector.startsWith("a.header-anchor")) {
        return allIdElements.flatMap((element) =>
          "children" in element ? element.children : []
        );
      }
      return headings;
    },
    createElement: () => {
      const anchor: FakeAnchor = {
        className: "",
        parentElement: null,
        title: "",
        attributes: new Map(),
        remove() {
          if (anchor.parentElement != null) {
            const index = anchor.parentElement.children.indexOf(anchor);
            if (index >= 0) {
              anchor.parentElement.children.splice(index, 1);
            }
          }
          anchor.parentElement = null;
        },
        setAttribute(name, value) {
          this.attributes.set(name, value);
        },
      };
      return anchor;
    },
  } as unknown as Document;
}

test("addHeaderAnchorLinks() enhances a document-unique heading ID", () => {
  const heading = createHeading("문서--제목");
  const document = createDocument([heading]);

  addHeaderAnchorLinks(document);
  addHeaderAnchorLinks(document);

  assert.equal(heading.children.length, 1);
  assert.equal(heading.children[0].className, "header-anchor");
  assert.equal(
    heading.children[0].attributes.get("href"),
    `#${encodeURIComponent("문서--제목")}`,
  );
  assert.equal(
    heading.children[0].attributes.get("aria-label"),
    "Link to this section",
  );
  assert.equal(heading.children[0].title, "Link to this section");
  assert.ok(
    heading.children[0].attributes.has("data-hackerspub-generated"),
  );
});

test("addHeaderAnchorLinks() skips duplicate IDs and reacts to later duplicates", () => {
  const first = createHeading("introduction");
  const headings = [first];
  const document = createDocument(headings);

  addHeaderAnchorLinks(document);
  assert.equal(first.children.length, 1);

  const second = createHeading("introduction");
  headings.push(second);
  addHeaderAnchorLinks(document);
  assert.equal(first.children.length, 0);
  assert.equal(second.children.length, 0);

  headings.pop();
  addHeaderAnchorLinks(document);
  assert.equal(first.children.length, 1);
});

test("addHeaderAnchorLinks() counts IDs outside prose headings", () => {
  const heading = createHeading("app");
  const outsideElement = { id: "app" };
  const document = createDocument([heading], [heading, outsideElement]);

  addHeaderAnchorLinks(document);

  assert.equal(heading.children.length, 0);
});

test("addHeaderAnchorLinks() refreshes href after a heading ID changes", () => {
  const heading = createHeading("before");
  const document = createDocument([heading]);

  addHeaderAnchorLinks(document);
  assert.equal(heading.children[0].attributes.get("href"), "#before");

  heading.id = "after";
  addHeaderAnchorLinks(document);
  assert.equal(heading.children.length, 1);
  assert.equal(heading.children[0].attributes.get("href"), "#after");
});

test("addHeaderAnchorLinks() removes controls that leave prose", () => {
  const heading = createHeading("section");
  const headings = [heading];
  const document = createDocument(headings, [heading]);

  addHeaderAnchorLinks(document);
  assert.equal(heading.children.length, 1);

  headings.pop();
  addHeaderAnchorLinks(document);
  assert.equal(heading.children.length, 0);
});

test("addHeaderAnchorLinks() ignores headings without IDs", () => {
  const heading = createHeading("");
  const document = createDocument([heading]);

  addHeaderAnchorLinks(document);

  assert.equal(heading.children.length, 0);
});
