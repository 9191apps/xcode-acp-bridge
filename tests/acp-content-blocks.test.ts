import { describe, expect, test } from "bun:test";
import {
  acpImageCaption,
  acpImageDataUrl,
  countAcpImagesFromRaw,
  extractAcpImages,
  extractAcpImagesFromRaw,
  redactAcpImageData,
} from "../src/acp/content-blocks";
import { conversationDetail } from "../src/acp/conversations";
import type { AcpEvent } from "../src/acp/types";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ev(over: Partial<AcpEvent> & Pick<AcpEvent, "id" | "ts" | "kind">): AcpEvent {
  return {
    bridgePid: 10,
    backendPid: 11,
    dir: null,
    rpcId: null,
    method: null,
    sessionHints: [],
    raw: "",
    truncated: false,
    parseError: null,
    ...over,
  };
}

const xcodePromptRaw = JSON.stringify({
  method: "session/prompt",
  params: {
    sessionId: "ses_x",
    prompt: [
      { type: "text", text: "Project structure (these are Xcode workspace-relative paths)" },
      {
        type: "image",
        mimeType: "image/png",
        url: "file:///tmp/Coding%20Assistant/Pasted%20Images/Pasted%202026-08-27.png",
        data: TINY_PNG,
      },
      { type: "text", text: "观察GFM Table的渲染" },
    ],
  },
});

const toolImageRaw = JSON.stringify({
  method: "session/update",
  params: {
    sessionId: "ses_x",
    update: {
      sessionUpdate: "tool_call_update",
      content: [
        { type: "content", content: { type: "text", text: "Image read successfully" } },
        { type: "content", content: { type: "image", mimeType: "image/png", data: TINY_PNG } },
      ],
    },
  },
});

describe("extractAcpImages", () => {
  test("finds Xcode session/prompt image blocks with url + data", () => {
    const images = extractAcpImagesFromRaw(xcodePromptRaw);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      mimeType: "image/png",
      data: TINY_PNG,
      url: "file:///tmp/Coding%20Assistant/Pasted%20Images/Pasted%202026-08-27.png",
    });
    expect(countAcpImagesFromRaw(xcodePromptRaw)).toBe(1);
  });

  test("finds nested tool_call_update image content", () => {
    const images = extractAcpImagesFromRaw(toolImageRaw);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: "image/png", data: TINY_PNG, url: null });
  });

  test("returns empty for text-only prompt", () => {
    const raw = JSON.stringify({
      params: { prompt: [{ type: "text", text: "hello" }] },
    });
    expect(extractAcpImagesFromRaw(raw)).toEqual([]);
    expect(countAcpImagesFromRaw(raw)).toBe(0);
  });

  test("returns empty for malformed raw", () => {
    expect(extractAcpImagesFromRaw("{not json")).toEqual([]);
    expect(extractAcpImagesFromRaw("")).toEqual([]);
  });

  test("counts url-only image with no data", () => {
    const images = extractAcpImages({
      type: "image",
      mimeType: "image/jpeg",
      uri: "file:///tmp/shot.jpg",
    });
    expect(images).toEqual([
      { mimeType: "image/jpeg", data: null, url: "file:///tmp/shot.jpg" },
    ]);
  });

  test("does not treat text blocks as images", () => {
    expect(
      extractAcpImages({ type: "text", text: "type is image in this sentence" }),
    ).toEqual([]);
  });
});

describe("acpImageDataUrl / caption", () => {
  test("builds a data URL for safe png base64", () => {
    expect(
      acpImageDataUrl({ mimeType: "image/png", data: TINY_PNG, url: null }),
    ).toBe(`data:image/png;base64,${TINY_PNG}`);
  });

  test("refuses svg and non-image mime types", () => {
    expect(
      acpImageDataUrl({
        mimeType: "image/svg+xml",
        data: "PHN2Zz48c2NyaXB0Pi88L3N2Zz4=",
        url: null,
      }),
    ).toBeNull();
    expect(
      acpImageDataUrl({ mimeType: "text/html", data: TINY_PNG, url: null }),
    ).toBeNull();
  });

  test("refuses missing or non-base64 data", () => {
    expect(acpImageDataUrl({ mimeType: "image/png", data: null, url: "file:///x.png" })).toBeNull();
    expect(acpImageDataUrl({ mimeType: "image/png", data: "<script>", url: null })).toBeNull();
  });

  test("caption prefers pasted filename then mime", () => {
    expect(
      acpImageCaption({
        mimeType: "image/png",
        data: TINY_PNG,
        url: "file:///tmp/Pasted%20Images/Pasted%202026-08-27.png",
      }),
    ).toContain("Pasted 2026-08-27.png");
    expect(acpImageCaption({ mimeType: "image/png", data: null, url: null })).toBe("image/png");
  });
});

describe("redactAcpImageData", () => {
  test("replaces image data with a size placeholder so JSON stays readable", () => {
    const redacted = redactAcpImageData(JSON.parse(xcodePromptRaw));
    const prompt = (redacted as { params: { prompt: Array<{ type?: string; data?: string }> } })
      .params.prompt;
    const image = prompt.find((p) => p.type === "image");
    expect(image?.data).toBe(`<base64 ${TINY_PNG.length} chars>`);
    expect(JSON.stringify(redacted)).not.toContain(TINY_PNG);
  });
});

describe("conversationDetail imageCount", () => {
  test("marks session/prompt rpc rows that carry images", () => {
    const detail = conversationDetail(
      [
        ev({
          id: "10-1",
          ts: "t1",
          kind: "rpc",
          method: "session/prompt",
          dir: "c2a",
          raw: xcodePromptRaw,
        }),
      ],
      10,
    );
    expect(detail!.timeline[0]).toMatchObject({
      type: "rpc",
      method: "session/prompt",
      imageCount: 1,
    });
  });

  test("folds tool_call_update and takes imageCount from the last raw", () => {
    const detail = conversationDetail(
      [
        ev({
          id: "10-1",
          ts: "t1",
          kind: "rpc",
          method: "session/update",
          dir: "a2c",
          sessionUpdate: "tool_call",
          toolName: "read",
          raw: "{}",
        }),
        ev({
          id: "10-2",
          ts: "t2",
          kind: "rpc",
          method: "session/update",
          dir: "a2c",
          sessionUpdate: "tool_call_update",
          toolName: "read",
          raw: toolImageRaw,
        }),
      ],
      10,
    );
    expect(detail!.timeline).toHaveLength(1);
    expect(detail!.timeline[0]).toMatchObject({
      type: "tool_call",
      name: "read",
      updateCount: 1,
      imageCount: 1,
    });
  });

  test("text-only prompt has imageCount 0", () => {
    const detail = conversationDetail(
      [
        ev({
          id: "10-1",
          ts: "t1",
          kind: "rpc",
          method: "session/prompt",
          dir: "c2a",
          raw: JSON.stringify({ params: { prompt: [{ type: "text", text: "hi" }] } }),
        }),
      ],
      10,
    );
    expect(detail!.timeline[0]).toMatchObject({ type: "rpc", imageCount: 0 });
  });
});
