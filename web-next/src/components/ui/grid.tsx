import type { Component, ComponentProps } from "solid-js";
import { mergeProps, splitProps } from "solid-js";

import { cn } from "~/lib/utils.ts";

type Cols = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
type Span = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

type GridProps = ComponentProps<"div"> & {
  cols?: Cols;
  colsSm?: Cols;
  colsMd?: Cols;
  colsLg?: Cols;
};

const Grid: Component<GridProps> = (rawProps) => {
  const props = mergeProps({ cols: 1 } satisfies GridProps, rawProps);
  const [local, others] = splitProps(props, [
    "cols",
    "colsSm",
    "colsMd",
    "colsLg",
    "class",
  ]);

  return (
    <div
      class={cn(
        "grid",
        gridCols[local.cols],
        local.colsSm && gridColsSm[local.colsSm],
        local.colsMd && gridColsMd[local.colsMd],
        local.colsLg && gridColsLg[local.colsLg],
        local.class,
      )}
      {...others}
    />
  );
};

type ColProps = ComponentProps<"div"> & {
  span?: Span;
  spanSm?: Span;
  spanMd?: Span;
  spanLg?: Span;
};

const Col: Component<ColProps> = (rawProps) => {
  const props = mergeProps({ span: 1 as Span }, rawProps);
  const [local, others] = splitProps(props, [
    "span",
    "spanSm",
    "spanMd",
    "spanLg",
    "class",
  ]);

  return (
    <div
      class={cn(
        colSpan[local.span],
        local.spanSm && colSpanSm[local.spanSm],
        local.spanMd && colSpanMd[local.spanMd],
        local.spanLg && colSpanLg[local.spanLg],
        local.class,
      )}
      {...others}
    />
  );
};

export { Col, Grid };

const gridCols: { [key in Cols]: string } = {
  0: "grid-cols-none",
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
  7: "grid-cols-7",
  8: "grid-cols-8",
  9: "grid-cols-9",
  10: "grid-cols-10",
  11: "grid-cols-11",
  12: "grid-cols-12",
};

const gridColsSm: { [key in Cols]: string } = {
  0: "sm:grid-cols-none",
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
  6: "sm:grid-cols-6",
  7: "sm:grid-cols-7",
  8: "sm:grid-cols-8",
  9: "sm:grid-cols-9",
  10: "sm:grid-cols-10",
  11: "sm:grid-cols-11",
  12: "sm:grid-cols-12",
};

const gridColsMd: { [key in Cols]: string } = {
  0: "md:grid-cols-none",
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  5: "md:grid-cols-5",
  6: "md:grid-cols-6",
  7: "md:grid-cols-7",
  8: "md:grid-cols-8",
  9: "md:grid-cols-9",
  10: "md:grid-cols-10",
  11: "md:grid-cols-11",
  12: "md:grid-cols-12",
};

const gridColsLg: { [key in Cols]: string } = {
  0: "lg:grid-cols-none",
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
  7: "lg:grid-cols-7",
  8: "lg:grid-cols-8",
  9: "lg:grid-cols-9",
  10: "lg:grid-cols-10",
  11: "lg:grid-cols-11",
  12: "lg:grid-cols-12",
};

const colSpan: { [key in Span]: string } = {
  1: "col-span-1",
  2: "col-span-2",
  3: "col-span-3",
  4: "col-span-4",
  5: "col-span-5",
  6: "col-span-6",
  7: "col-span-7",
  8: "col-span-8",
  9: "col-span-9",
  10: "col-span-10",
  11: "col-span-11",
  12: "col-span-12",
  13: "col-span-13",
};

const colSpanSm: { [key in Span]: string } = {
  1: "sm:col-span-1",
  2: "sm:col-span-2",
  3: "sm:col-span-3",
  4: "sm:col-span-4",
  5: "sm:col-span-5",
  6: "sm:col-span-6",
  7: "sm:col-span-7",
  8: "sm:col-span-8",
  9: "sm:col-span-9",
  10: "sm:col-span-10",
  11: "sm:col-span-11",
  12: "sm:col-span-12",
  13: "sm:col-span-13",
};

const colSpanMd: { [key in Span]: string } = {
  1: "md:col-span-1",
  2: "md:col-span-2",
  3: "md:col-span-3",
  4: "md:col-span-4",
  5: "md:col-span-5",
  6: "md:col-span-6",
  7: "md:col-span-7",
  8: "md:col-span-8",
  9: "md:col-span-9",
  10: "md:col-span-10",
  11: "md:col-span-11",
  12: "md:col-span-12",
  13: "md:col-span-13",
};

const colSpanLg: { [key in Span]: string } = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
  5: "lg:col-span-5",
  6: "lg:col-span-6",
  7: "lg:col-span-7",
  8: "lg:col-span-8",
  9: "lg:col-span-9",
  10: "lg:col-span-10",
  11: "lg:col-span-11",
  12: "lg:col-span-12",
  13: "lg:col-span-13",
};
