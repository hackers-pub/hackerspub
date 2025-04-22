import { Msg } from "./Msg.tsx";

export interface PostPaginationProps {
  nextHref?: string | URL;
}

export function PostPagination({ nextHref }: PostPaginationProps) {
  return (
    <nav class="text-center my-16">
      {nextHref
        ? (
          <a href={nextHref.toString()} rel="next">
            <Msg $key="postPagination.more" />
            <br />
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="size-6 mx-auto mt-4"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m4.5 5.25 7.5 7.5 7.5-7.5m-15 6 7.5 7.5 7.5-7.5"
              />
            </svg>
          </a>
        )
        : (
          <p>
            <Msg $key="postPagination.end" />
            <br />
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="size-6 mx-auto mt-4"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m4.5 12.75 6 6 9-13.5"
              />
            </svg>
          </p>
        )}
    </nav>
  );
}
