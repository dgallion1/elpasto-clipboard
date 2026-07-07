// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QRCode } from "./QRCode";

afterEach(() => cleanup());

describe("QRCode", () => {
  test("shows a loading placeholder then renders an svg", async () => {
    const view = render(<QRCode value="https://elpasto.app/elk-piano-river" />);
    expect(view.getByLabelText("Loading QR code")).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector("svg")).toBeTruthy());
  });
});
