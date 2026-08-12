import React from "react";
import { ActivityViewer } from "../../../src/activity-viewer";
import type { ActivitySource } from "../../../src/Activity/activityState";
import type { SingleDocSource } from "../../../src/Activity/singleDocState";
import { IFRAME_READY_TIMEOUT, PARK_TIMEOUT } from "./helpers";

// Windowed mounting (#35, #36, #37): every item's DoenetViewer is mounted,
// but the wrapper's mountPolicy decides which are booted — memory tracks the
// pagination window / viewport, not assignment length. Parking is lossless:
// state is flushed before the iframe is detached and restored on return.

function mkDoc(id: string, label: string): SingleDocSource {
    return {
        id,
        type: "singleDoc",
        isDescription: false,
        doenetML: `<p>${label}: <textInput name="ti" /></p><p>typed: $ti.value</p>`,
        // At or above PARK_MIN_VERSION (0.7.21) the iframe wrapper gates
        // parking on the doc version, so parking works without a
        // host-specified standaloneUrl — the bundle/CSS auto-resolve.
        version: "0.7.24",
        numVariants: 1,
    };
}

function mkSequence(numDocs: number): ActivitySource {
    return {
        type: "sequence",
        id: "seq",
        title: "windowed",
        shuffle: false,
        items: Array.from({ length: numDocs }, (_, i) =>
            mkDoc(`doc${(i + 1).toString()}`, `Doc ${(i + 1).toString()}`),
        ),
    } as ActivitySource;
}

/**
 * The iframe of the item with the given id: the DoenetViewer bakes its
 * props (including `docId`) into the iframe's srcdoc. A windowed viewer
 * only has an iframe while booted — parked viewers are placeholders.
 */
function itemIframe(id: string, options?: { timeout?: number }) {
    return cy.get(`iframe[srcdoc*='"docId":"${id}"']`, options);
}

/** Assert rendered (script-stripped) iframe content for an item. */
function assertItemContent(id: string, text: string) {
    itemIframe(id)
        .its("0.contentDocument.body", { timeout: IFRAME_READY_TIMEOUT })
        .should((body: HTMLElement) => {
            const clone = body.cloneNode(true) as HTMLElement;
            clone.querySelectorAll("script").forEach((s) => {
                s.remove();
            });
            expect(clone.textContent).to.contain(text);
        });
}

describe("ActivityViewer — windowed mounting", () => {
    it("paginated: keeps the window live, parks beyond it, and restores typed work", () => {
        cy.viewport(900, 700);
        cy.mount(
            <ActivityViewer
                source={mkSequence(5)}
                activityId="windowed-paginated"
                flags={{ allowSaveState: true }}
                paginate={true}
                addVirtualKeyboard={false}
                mountPolicy={{ parkDelayMs: 300, flushTimeoutMs: 15_000 }}
            />,
        );

        // Page 1 (current, keepLive) boots and renders; its neighbor
        // prefetches in the background. Pages beyond the window never boot.
        assertItemContent("doc1", "typed:");
        itemIframe("doc2", { timeout: IFRAME_READY_TIMEOUT }).should("exist");
        cy.get("iframe").should("have.length.at.most", 3);
        itemIframe("doc4").should("not.exist");
        itemIframe("doc5").should("not.exist");

        // Type into page 1 and commit with Enter.
        itemIframe("doc1")
            .its("0.contentDocument.body")
            .find("input:not([type=checkbox])")
            .then(($el) => cy.wrap($el))
            .type("windowed work{enter}");
        assertItemContent("doc1", "typed: windowed work");

        // Page forward to 4: the window moves; doc1 leaves it and parks
        // (iframe detached), and the live-iframe count stays bounded.
        cy.contains("button", "Next").click();
        cy.contains("button", "Next").click();
        cy.contains("button", "Next").click();
        assertItemContent("doc4", "typed:");
        itemIframe("doc1", { timeout: PARK_TIMEOUT }).should("not.exist");
        cy.get("iframe", { timeout: PARK_TIMEOUT }).should(
            "have.length.at.most",
            3,
        );

        // Page back to 1: it restores — typed work intact, no interaction.
        cy.contains("button", "Previous").click();
        cy.contains("button", "Previous").click();
        cy.contains("button", "Previous").click();
        assertItemContent("doc1", "typed: windowed work");
        itemIframe("doc1")
            .its("0.contentDocument.body", { timeout: IFRAME_READY_TIMEOUT })
            .find("input:not([type=checkbox])")
            .should("have.value", "windowed work");
    });

    it("scroll mode: off-screen items never boot; scrolling boots them and parks the ones left behind", () => {
        cy.viewport(900, 600);
        cy.mount(
            <ActivityViewer
                source={mkSequence(5)}
                activityId="windowed-scroll"
                flags={{ allowSaveState: true }}
                paginate={false}
                addVirtualKeyboard={false}
                mountPolicy={{
                    maxLiveViewers: 2,
                    visibleMargin: "100px",
                    parkDelayMs: 300,
                    flushTimeoutMs: 15_000,
                }}
            />,
        );

        // The first item (in the viewport) boots; the last is far below the
        // 100px margin (parked placeholders are ~500px tall) and never does.
        assertItemContent("doc1", "typed:");
        itemIframe("doc5").should("not.exist");

        // Scroll to the bottom: the far items boot; the ones left behind
        // exceed the budget of 2 and park (bounded iframe count).
        cy.scrollTo("bottom", { duration: 500 });
        assertItemContent("doc5", "typed:");
        itemIframe("doc1", { timeout: PARK_TIMEOUT }).should("not.exist");
        cy.get("iframe", { timeout: PARK_TIMEOUT }).should(
            "have.length.at.most",
            2,
        );
    });
});
