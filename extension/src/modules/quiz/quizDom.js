/**
 * Quiz DOM Module: Handles all DOM extraction, KaTeX math rendering,
 * precision option selection, navigation, and submission confirmation on the active webpage.
 */

/**
 * Extracts questions and radio options from the active tab.
 * @param {number} tabId
 * @param {boolean} [lightweight=false]
 * @returns {Promise<Object>} Extracted DOM data including questions array and HTML strings
 */
export async function extractQuizQuestionsFromPage(tabId, lightweight = false) {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) {
    throw new Error('Chrome scripting API is not available or tab is invalid.');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (isLightweight) => {
      const getAttributes = (el) => {
        if (!el || !el.attributes) return {};
        const attrs = {};
        for (let i = 0; i < el.attributes.length; i++) {
          const a = el.attributes[i];
          attrs[a.name] = a.value;
        }
        return attrs;
      };

      // Extract clean text while preserving LaTeX formulas from KaTeX elements
      const extractCleanMathText = (el) => {
        if (!el) return '';
        const clone = el.cloneNode(true);

        // In KaTeX, replace .katex container with LaTeX code from <annotation encoding="application/x-tex">
        const katexEls = clone.querySelectorAll('.katex, [data-testid="react-katex"]');
        katexEls.forEach((katex) => {
          const annot = katex.querySelector('annotation[encoding*="tex"]');
          if (annot && annot.textContent.trim()) {
            const tex = annot.textContent.trim();
            const textNode = document.createTextNode(` ${tex} `);
            katex.parentNode?.replaceChild(textNode, katex);
          } else {
            const mathml = katex.querySelector('.katex-mathml');
            if (mathml) {
              const textNode = document.createTextNode(` ${mathml.textContent.trim()} `);
              katex.parentNode?.replaceChild(textNode, katex);
            }
          }
        });

        clone.querySelectorAll('svg, math').forEach((s) => s.remove());
        return (clone.innerText || clone.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
      };

      const radioInputs = Array.from(document.querySelectorAll('input[type="radio"]'));

      const groups = {};
      radioInputs.forEach((radio) => {
        const name = radio.name || 'unnamed_group';
        if (!groups[name]) groups[name] = [];
        groups[name].push(radio);
      });

      const questionHeadings = Array.from(
        document.querySelectorAll(
          '.text-span-question-renderer, [class*="text-span-question-renderer"], [data-testid*="question"]'
        )
      );

      const extractedQuestions = [];
      const parentContainerElements = [];

      Object.entries(groups).forEach(([groupName, radios], gIdx) => {
        if (!radios.length) return;

        let commonParent = radios[0].parentElement;
        while (commonParent && commonParent !== document.body) {
          const allInside = radios.every((r) => commonParent.contains(r));
          if (allInside) break;
          commonParent = commonParent.parentElement;
        }
        if (!commonParent) commonParent = radios[0].parentElement || document.body;

        let questionEl = null;
        let questionText = '';
        let questionId = null;

        questionEl = commonParent.querySelector(
          '.text-span-question-renderer, [class*="text-span-question-renderer"]'
        );

        if (!questionEl && questionHeadings.length > 0) {
          const precedingHeadings = questionHeadings.filter((el) => {
            const pos = el.compareDocumentPosition(radios[0]);
            return (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
          });
          if (precedingHeadings.length > 0) {
            questionEl = precedingHeadings[precedingHeadings.length - 1];
            let ancestor = commonParent;
            while (ancestor && ancestor !== document.body) {
              if (ancestor.contains(questionEl)) {
                commonParent = ancestor;
                break;
              }
              ancestor = ancestor.parentElement;
            }
          }
        }

        if (questionEl) {
          questionText = extractCleanMathText(questionEl);
          questionId =
            questionEl.id ||
            questionEl.getAttribute('data-question-id') ||
            questionEl.getAttribute('data-id') ||
            null;
        }

        if (!questionText) {
          const heading = commonParent.querySelector('h1, h2, h3, h4, h5, h6, strong, p');
          if (heading) {
            questionText = extractCleanMathText(heading);
            questionId = heading.id || null;
          }
        }

        if (!questionId && commonParent) {
          questionId =
            commonParent.id ||
            commonParent.getAttribute('data-question-id') ||
            commonParent.getAttribute('data-id') ||
            null;
        }

        if (!questionId) {
          questionId = groupName !== 'unnamed_group' ? groupName : `question_${gIdx + 1}`;
        }

        if (!questionText) {
          const clone = commonParent.cloneNode(true);
          clone.querySelectorAll('input, label').forEach((el) => el.remove());
          questionText = extractCleanMathText(clone);
        }

        if (!questionText) {
          questionText = `Question ${gIdx + 1}`;
        }

        const options = radios.map((radio, rIdx) => {
          let labelText = '';
          let labelEl = radio.closest('label');
          if (!labelEl && radio.id) {
            try {
              labelEl = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
            } catch {}
          }

          let badgeLetter = '';
          if (labelEl) {
            // Find leaf badge element with single letter A-Z
            const badgeCandidates = Array.from(
              labelEl.querySelectorAll(
                '.kuwkNu, .bIKUCi, [class*="kuwkNu"], [class*="bIKUCi"], [class*="badge" i], [class*="letter" i], div, span, b, strong'
              )
            );
            for (const el of badgeCandidates) {
              if (el.children.length === 0) {
                const bTxt = (el.innerText || el.textContent || '').trim();
                if (/^[A-Z]$/i.test(bTxt)) {
                  badgeLetter = bTxt.toUpperCase();
                  break;
                }
              }
            }
          }
          if (!badgeLetter) {
            badgeLetter = String.fromCharCode(65 + rIdx);
          }

          if (labelEl) {
            const labelClone = labelEl.cloneNode(true);
            labelClone.querySelectorAll('input[type="radio"], svg').forEach((el) => el.remove());
            // Strip the badge element itself from clone so it doesn't pollute clean option text
            const cloneCandidates = Array.from(
              labelClone.querySelectorAll(
                '.kuwkNu, .bIKUCi, [class*="kuwkNu"], [class*="bIKUCi"], [class*="badge" i], [class*="letter" i], div, span, b, strong'
              )
            );
            for (const cEl of cloneCandidates) {
              if (cEl.children.length === 0 && (cEl.textContent || '').trim().toUpperCase() === badgeLetter) {
                cEl.remove();
                break;
              }
            }
            labelText = extractCleanMathText(labelClone);
          } else if (radio.parentElement) {
            const parentClone = radio.parentElement.cloneNode(true);
            parentClone.querySelectorAll('input[type="radio"], svg').forEach((el) => el.remove());
            labelText = extractCleanMathText(parentClone);
          }

          let optionId =
            radio.id ||
            radio.getAttribute('data-id') ||
            radio.getAttribute('data-option-id') ||
            null;

          if (!optionId && labelEl) {
            optionId =
              labelEl.id ||
              labelEl.getAttribute('data-id') ||
              labelEl.getAttribute('data-option-id') ||
              null;
          }
          if (!optionId) {
            optionId = `${groupName}_opt_${rIdx + 1}`;
          }

          const cleanText = labelText.replace(/^[A-Z][\.\:\)\-\s]+/i, '').trim() || labelText;

          // Multi-signal detection if this option is already selected on page
          let isSelected = Boolean(radio.checked);
          if (!isSelected && labelEl) {
            try {
              const bg = window.getComputedStyle(labelEl).backgroundColor || '';
              const border = window.getComputedStyle(labelEl).borderColor || '';
              const isPurpleBg =
                bg.includes('rgba(97, 56, 211') ||
                bg.includes('rgb(97, 56, 211') ||
                bg.includes('238, 242, 255');
              const isPurpleBorder =
                border.includes('97, 56, 211') ||
                border.includes('rgb(97, 56, 211');
              const hasCheckedClass =
                labelEl.className &&
                typeof labelEl.className === 'string' &&
                (labelEl.className.includes('jYwWeR') ||
                  labelEl.className.includes('selected') ||
                  labelEl.className.includes('checked'));
              if (isPurpleBg || isPurpleBorder || hasCheckedClass) {
                isSelected = true;
              }
            } catch {}
          }

          return {
            index: rIdx + 1,
            optionLetter: badgeLetter,
            optionId,
            id: radio.id || null,
            name: radio.name || null,
            value: radio.value || null,
            checked: radio.checked,
            isSelected,
            text: cleanText,
            rawText: labelText,
            targetDescriptor: {
              id: radio.id || null,
              value: radio.value || null,
              name: radio.name || null,
              text: cleanText,
              optionLetter: badgeLetter,
              index: rIdx,
            },
          };
        });

        // Precompute standard LLM payload
        const optionsMap = {};
        options.forEach((opt, idx) => {
          const key = opt.optionLetter || String.fromCharCode(65 + idx);
          optionsMap[key] = opt.text;
        });

        extractedQuestions.push({
          questionIndex: gIdx + 1,
          questionId,
          questionText,
          groupName,
          options,
          llmPayload: {
            q: questionText,
            o: optionsMap,
          },
        });

        if (commonParent && !parentContainerElements.includes(commonParent)) {
          parentContainerElements.push(commonParent);
        }
      });

      const onlyRadioContainersHtml = parentContainerElements
        .map((el, i) => `<!-- Group ${i + 1} Container -->\n${el.outerHTML}`)
        .join('\n\n');

      return {
        fullHtml: isLightweight ? '' : document.documentElement.outerHTML,
        onlyRadioContainersHtml,
        questions: extractedQuestions,
        totalQuestionsFound: extractedQuestions.length,
      };
    },
    args: [lightweight],
  });

  return results?.[0]?.result || { fullHtml: '', onlyRadioContainersHtml: '', questions: [], totalQuestionsFound: 0 };
}

/**
 * Clicks a specific quiz radio option on the webpage and confirms selection.
 * @param {number} tabId
 * @param {Object} targetDescriptor
 * @param {number} optIndex
 * @param {string} groupName
 * @returns {Promise<Object>} Result of click attempt with verification status
 */
export async function clickQuizOptionOnPage(tabId, targetDescriptor, optIndex = 0, groupName = '') {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) {
    throw new Error('Chrome scripting API is not available.');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [targetDescriptor, optIndex, groupName],
    func: (desc, fallbackIndex, fallbackGroup) => {
      try {
        const radios = Array.from(document.querySelectorAll('input[type="radio"]'));

        const checkIsSelected = (radio) => {
          if (!radio) return false;
          if (radio.checked) return true;
          const label = radio.closest('label') || document.querySelector(`label[for="${CSS.escape(radio.id || '')}"]`);
          if (label) {
            try {
              const bg = window.getComputedStyle(label).backgroundColor || '';
              const border = window.getComputedStyle(label).borderColor || '';
              const isPurpleBg =
                bg.includes('rgba(97, 56, 211') ||
                bg.includes('rgb(97, 56, 211') ||
                bg.includes('238, 242, 255');
              const isPurpleBorder =
                border.includes('97, 56, 211') ||
                border.includes('rgb(97, 56, 211');
              const hasCheckedClass =
                label.className &&
                typeof label.className === 'string' &&
                (label.className.includes('jYwWeR') ||
                  label.className.includes('selected') ||
                  label.className.includes('checked'));
              if (isPurpleBg || isPurpleBorder || hasCheckedClass) return true;
            } catch {}
          }
          return false;
        };

        const effectiveGroup = desc?.name || fallbackGroup || '';
        const groupRadios = effectiveGroup
          ? radios.filter((r) => r.name === effectiveGroup)
          : radios;

        const targetLetter = (
          desc?.optionLetter ||
          (typeof fallbackIndex === 'number' && fallbackIndex >= 0
            ? String.fromCharCode(65 + fallbackIndex)
            : '')
        ).toUpperCase().trim();

        let target = null;
        let matchedBy = 'none';

        // 1. Strategy 1: Match by visual badge letter within group (Ground truth on Newton School & standard MCQs)
        if (targetLetter && groupRadios.length > 0) {
          for (const radio of groupRadios) {
            const label = radio.closest('label');
            if (label) {
              const candidates = Array.from(label.querySelectorAll('div, span, b, strong, p'));
              const hasBadge = candidates.some((el) => {
                const t = (el.innerText || el.textContent || '').trim().toUpperCase();
                return t === targetLetter && el.children.length === 0;
              });
              if (hasBadge) {
                target = radio;
                matchedBy = `badge_letter_${targetLetter}`;
                break;
              }
            }
          }
        }

        // 2. Strategy 2: Match by position index within group (0 = A, 1 = B, 2 = C, 3 = D)
        if (!target && groupRadios.length > 0) {
          const letterIndex = targetLetter ? targetLetter.charCodeAt(0) - 65 : -1;
          const optIdx =
            typeof desc?.index === 'number' && desc.index >= 0
              ? desc.index
              : letterIndex >= 0
              ? letterIndex
              : fallbackIndex;

          if (typeof optIdx === 'number' && optIdx >= 0 && groupRadios[optIdx]) {
            target = groupRadios[optIdx];
            matchedBy = `group_index_${optIdx}`;
          }
        }

        // 3. Strategy 3: Match by Option Text within group labels
        if (!target && desc?.text && groupRadios.length > 0) {
          const cleanDescText = desc.text.toLowerCase().trim();
          if (cleanDescText) {
            const matchedRadio = groupRadios.find((r) => {
              const label = r.closest('label') || document.querySelector(`label[for="${CSS.escape(r.id || '')}"]`);
              if (!label) return false;
              const lText = (label.innerText || label.textContent || '').toLowerCase().trim();
              return lText.includes(cleanDescText) || cleanDescText.includes(lText);
            });
            if (matchedRadio) {
              target = matchedRadio;
              matchedBy = 'group_label_text';
            }
          }
        }

        // 4. Strategy 4: Match by unique radio ID (ONLY if the ID is strictly unique in document!)
        if (!target && desc?.id) {
          try {
            const matches = document.querySelectorAll(`#${CSS.escape(desc.id)}`);
            if (matches.length === 1) {
              target = matches[0];
              matchedBy = 'unique_id';
            }
          } catch {}
        }

        // 5. Strategy 5: Global radio fallback index
        if (!target) {
          const letterIndex = targetLetter ? targetLetter.charCodeAt(0) - 65 : -1;
          const globalIdx =
            typeof desc?.index === 'number' && desc.index >= 0
              ? desc.index
              : letterIndex >= 0
              ? letterIndex
              : fallbackIndex;

          if (typeof globalIdx === 'number' && globalIdx >= 0 && radios[globalIdx]) {
            target = radios[globalIdx];
            matchedBy = `global_index_${globalIdx}`;
          }
        }

        if (!target) {
          return { success: false, failureReason: 'Radio element could not be located in page DOM.' };
        }

        // Check if already selected to prevent accidental unselection
        const wasPreselected = checkIsSelected(target);
        if (wasPreselected) {
          return {
            success: true,
            radioChecked: true,
            alreadySelected: true,
            wasPreselected: true,
            matchedBy,
            note: 'Target option was already selected on page.',
          };
        }

        // Focus & Scroll
        if (typeof target.scrollIntoView === 'function') {
          try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
        }
        if (typeof target.focus === 'function') {
          try { target.focus({ preventScroll: true }); } catch {}
        }

        // Event cascade
        const clickEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        const label = target.closest('label') || (target.id ? document.querySelector(`label[for="${CSS.escape(target.id)}"]`) : null);

        // Click native elements
        clickEvents.forEach((type) => {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail: 1, button: 0 }));
        });
        target.click();

        if (label) {
          clickEvents.forEach((type) => {
            label.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail: 1, button: 0 }));
          });
          label.click();
        }

        // Trigger React synthetic handlers if present
        const reactPropsKey = Object.keys(target).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
        if (reactPropsKey && target[reactPropsKey]?.onChange) {
          try { target[reactPropsKey].onChange({ target, currentTarget: target, bubbles: true }); } catch {}
        }
        if (label) {
          const labelReactProps = Object.keys(label).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
          if (labelReactProps && label[labelReactProps]?.onClick) {
            try { label[labelReactProps].onClick({ target: label, currentTarget: label, bubbles: true }); } catch {}
          }
        }

        target.checked = true;
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.dispatchEvent(new Event('input', { bubbles: true }));

        const nowSelected = checkIsSelected(target);

        return {
          success: nowSelected || target.checked,
          radioChecked: target.checked,
          alreadySelected: false,
          wasPreselected: false,
          matchedBy,
          diagnostics: {
            nowSelected,
            radioChecked: target.checked,
            id: target.id,
            name: target.name,
            value: target.value,
          },
        };
      } catch (err) {
        return { success: false, failureReason: `Exception in page script: ${err.message}` };
      }
    },
  });

  return results?.[0]?.result || { success: false, failureReason: 'Script execution returned no result.' };
}

/**
 * Gets live quiz navigation status from webpage (e.g. "Question 3/8", next button, submit button).
 * @param {number} tabId
 * @returns {Promise<Object>} Navigation metadata
 */
export async function getQuizNavigationInfo(tabId) {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) return null;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let currentNum = null;
        let totalNum = null;

        const counterEl = Array.from(document.querySelectorAll('div, span, p')).find((el) => {
          const text = (el.innerText || '').trim();
          return /question\s*\d+\s*[\/|of]\s*\d+/i.test(text) && el.children.length === 0;
        });

        if (counterEl) {
          const match = (counterEl.innerText || '').match(/question\s*(\d+)\s*[\/|of]\s*(\d+)/i);
          if (match) {
            currentNum = parseInt(match[1], 10);
            totalNum = parseInt(match[2], 10);
          }
        }

        const nextBtn =
          document.querySelector('button.RTaWA:not([disabled])') ||
          Array.from(document.querySelectorAll('button:not([disabled])')).find((b) => {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            return (txt.startsWith('next') || txt === 'next') && !txt.includes('submit');
          });

        const submitBtn =
          document.querySelector('button.sc-ad068bc-5.eWYOUm:not([disabled])') ||
          document.querySelector('button.eWYOUm:not([disabled])') ||
          document.querySelector('button.sc-ad068bc-5:not([disabled])') ||
          document.querySelector('button[class*="eWYOUm"]:not([disabled])') ||
          Array.from(document.querySelectorAll('button:not([disabled])')).find((b) => {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            return txt.includes('submit quiz');
          });

        return {
          currentNum,
          totalNum,
          hasNext: Boolean(nextBtn),
          hasSubmit: Boolean(submitBtn),
          counterText: counterEl?.innerText?.trim() || '',
        };
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

/**
 * Clicks the "Next" button on webpage to advance to the next quiz question.
 * @param {number} tabId
 * @returns {Promise<boolean>} Success status
 */
export async function clickNextQuestionOnPage(tabId) {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) return false;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const candidates = [
          document.querySelector('button.RTaWA:not([disabled])'),
          document.querySelector('button[class*="RTaWA"]:not([disabled])'),
          ...Array.from(document.querySelectorAll('button:not([disabled])')).filter((b) => {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            return (
              txt === 'next' ||
              txt.startsWith('next') ||
              txt.includes('next')
            ) && !txt.includes('submit') && !txt.includes('clear') && !txt.includes('review');
          }),
        ].filter(Boolean);

        const nextBtn = candidates[0];
        if (!nextBtn) return false;

        if (typeof nextBtn.focus === 'function') {
          try { nextBtn.focus({ preventScroll: true }); } catch {}
        }
        const mouseEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        mouseEvents.forEach((type) => {
          nextBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail: 1, button: 0, buttons: 1 }));
        });
        nextBtn.click();

        const reactPropsKey = Object.keys(nextBtn).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
        if (reactPropsKey && nextBtn[reactPropsKey]?.onClick) {
          try {
            nextBtn[reactPropsKey].onClick({ target: nextBtn, currentTarget: nextBtn, bubbles: true });
          } catch {}
        }
        return true;
      },
    });
    return Boolean(results?.[0]?.result);
  } catch {
    return false;
  }
}

/**
 * Polls until the question text or counter changes on webpage.
 * @param {number} tabId
 * @param {string} previousQuestionText
 * @param {number} currentQuestionNum
 * @param {number} [timeoutMs=4000]
 */
export async function waitForNextQuestionToRender(tabId, previousQuestionText, currentQuestionNum, timeoutMs = 4000) {
  const pollInterval = 150;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const pollRes = await chrome.scripting.executeScript({
      target: { tabId },
      func: (prevText, prevNum) => {
        let newNum = null;
        const counterEl = Array.from(document.querySelectorAll('div, span, p')).find((el) => {
          const text = (el.innerText || '').trim();
          return /question\s*\d+\s*[\/|of]\s*\d+/i.test(text) && el.children.length === 0;
        });
        if (counterEl) {
          const match = (counterEl.innerText || '').match(/question\s*(\d+)/i);
          if (match) newNum = parseInt(match[1], 10);
        }

        let newText = '';
        const qEl = document.querySelector('.text-span-question-renderer, [class*="text-span-question-renderer"]');
        if (qEl) newText = (qEl.innerText || qEl.textContent || '').replace(/\s+/g, ' ').trim();

        const numAdvanced = newNum !== null && prevNum !== null && newNum > prevNum;
        const textChanged = Boolean(newText && prevText && newText !== prevText);

        return numAdvanced || textChanged;
      },
      args: [previousQuestionText, currentQuestionNum],
    });

    if (pollRes?.[0]?.result) {
      await new Promise((r) => setTimeout(r, 100));
      return true;
    }
  }
  return true;
}

/**
 * Clicks the primary Submit Quiz button on webpage and confirms the "Yes" dialog modal.
 * @param {number} tabId
 * @returns {Promise<Object>} Result of submission and modal confirmation
 */
export async function clickSubmitQuizOnPage(tabId) {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) {
    return { success: false, reason: 'Chrome scripting not available' };
  }

  try {
    const mainSubmitResult = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const triggerClick = (el) => {
          if (!el) return false;
          if (typeof el.scrollIntoView === 'function') {
            try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch {}
          }
          if (typeof el.focus === 'function') {
            try { el.focus({ preventScroll: true }); } catch {}
          }
          const mouseEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
          mouseEvents.forEach((type) => {
            try {
              el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail: 1, button: 0, buttons: 1 }));
            } catch {}
          });
          try { el.click(); } catch {}

          const reactPropsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
          if (reactPropsKey && el[reactPropsKey]?.onClick) {
            try {
              el[reactPropsKey].onClick({ target: el, currentTarget: el, bubbles: true });
            } catch {}
          }

          const inner = el.querySelector('div, span, svg');
          if (inner && inner !== el) {
            try {
              inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 1, button: 0 }));
            } catch {}
          }
          return true;
        };

        const findYesButton = () => {
          const directCandidates = [
            document.querySelector('button.sc-4ea2be4c-8.jAUIkA:not([disabled])'),
            document.querySelector('button.jAUIkA:not([disabled])'),
            document.querySelector('.sc-4ea2be4c-0 button.jAUIkA:not([disabled])'),
            document.querySelector('.sc-4ea2be4c-10 button.jAUIkA:not([disabled])'),
          ].filter(Boolean);
          if (directCandidates.length > 0) return directCandidates[0];

          const modalContainers = Array.from(
            document.querySelectorAll(
              '.sc-4ea2be4c-0, [role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="popup" i], div'
            )
          ).filter((el) => {
            const txt = (el.innerText || el.textContent || '').toLowerCase();
            return (
              (txt.includes('confirm to submit') ||
                txt.includes('are you sure you want to submit') ||
                (txt.includes('submit') && (txt.includes('quiz') || txt.includes('sure')))) &&
              (txt.includes('yes') || txt.includes('no'))
            );
          });

          for (const modal of modalContainers) {
            const btns = Array.from(modal.querySelectorAll('button:not([disabled])'));
            const yes = btns.find((b) => {
              const bTxt = (b.innerText || b.textContent || '').trim().toLowerCase();
              const hasCheck = Boolean(b.querySelector('svg[data-icon="check"], [class*="check" i]'));
              return (bTxt === 'yes' || bTxt.startsWith('yes') || hasCheck) && !bTxt.includes('no') && !bTxt.includes('cancel');
            });
            if (yes) return yes;
          }

          const allYes = Array.from(document.querySelectorAll('button:not([disabled])')).filter((b) => {
            const bTxt = (b.innerText || b.textContent || '').trim().toLowerCase();
            const hasCheck = Boolean(b.querySelector('svg[data-icon="check"]'));
            return (bTxt === 'yes' || hasCheck) && !bTxt.includes('no');
          });
          if (allYes.length > 0) return allYes[allYes.length - 1];

          return null;
        };

        const alreadyOpenYes = findYesButton();
        if (alreadyOpenYes) {
          triggerClick(alreadyOpenYes);
          return { success: true, alreadyOpen: true, confirmed: true };
        }

        const submitBtn =
          document.querySelector('button.sc-ad068bc-5.eWYOUm:not([disabled])') ||
          document.querySelector('button.eWYOUm:not([disabled])') ||
          document.querySelector('button.sc-ad068bc-5:not([disabled])') ||
          document.querySelector('button[class*="eWYOUm"]:not([disabled])') ||
          Array.from(document.querySelectorAll('button:not([disabled])')).find((b) => {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            return txt.includes('submit quiz');
          });

        if (!submitBtn) {
          return { success: false, reason: 'Submit Quiz button not found or disabled' };
        }

        triggerClick(submitBtn);
        return { success: true, mainClicked: true };
      },
    });

    const initialRes = mainSubmitResult?.[0]?.result;
    if (!initialRes?.success) {
      return { success: false, reason: initialRes?.reason || 'Submit Quiz button not found' };
    }

    if (initialRes?.alreadyOpen && initialRes?.confirmed) {
      await new Promise((r) => setTimeout(r, 600));
      return { success: true, confirmed: true };
    }

    // Poll across document for the confirmation modal and click "Yes"
    let confirmed = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((r) => setTimeout(r, 200));

      const modalResult = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const triggerClick = (el) => {
            if (!el) return false;
            if (typeof el.scrollIntoView === 'function') {
              try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch {}
            }
            if (typeof el.focus === 'function') {
              try { el.focus({ preventScroll: true }); } catch {}
            }
            const mouseEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
            mouseEvents.forEach((type) => {
              try {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail: 1, button: 0, buttons: 1 }));
              } catch {}
            });
            try { el.click(); } catch {}

            const reactPropsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
            if (reactPropsKey && el[reactPropsKey]?.onClick) {
              try { el[reactPropsKey].onClick({ target: el, currentTarget: el, bubbles: true }); } catch {}
            }

            const inner = el.querySelector('div, span, svg');
            if (inner && inner !== el) {
              try { inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 1, button: 0 })); } catch {}
            }
            return true;
          };

          const yesCandidates = [
            document.querySelector('button.sc-4ea2be4c-8.jAUIkA:not([disabled])'),
            document.querySelector('button.jAUIkA:not([disabled])'),
            document.querySelector('.sc-4ea2be4c-0 button.jAUIkA:not([disabled])'),
            document.querySelector('.sc-4ea2be4c-10 button.jAUIkA:not([disabled])'),
            ...Array.from(document.querySelectorAll('.sc-4ea2be4c-0 button, .sc-4ea2be4c-10 button')).filter((b) => {
              const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
              return (txt === 'yes' || txt.startsWith('yes') || b.querySelector('svg[data-icon="check"]')) && !txt.includes('no');
            }),
          ].filter(Boolean);

          if (yesCandidates.length > 0) {
            triggerClick(yesCandidates[0]);
            return { confirmed: true, method: 'direct-yes-button' };
          }

          const modalContainers = Array.from(
            document.querySelectorAll(
              '.sc-4ea2be4c-0, [role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="popup" i], div'
            )
          ).filter((el) => {
            const txt = (el.innerText || el.textContent || '').toLowerCase();
            return (
              (txt.includes('confirm to submit') ||
                txt.includes('are you sure you want to submit') ||
                (txt.includes('submit') && (txt.includes('quiz') || txt.includes('sure')))) &&
              (txt.includes('yes') || txt.includes('no'))
            );
          });

          for (const modal of modalContainers) {
            const btns = Array.from(modal.querySelectorAll('button:not([disabled])'));
            const yes = btns.find((b) => {
              const bTxt = (b.innerText || b.textContent || '').trim().toLowerCase();
              const hasCheck = Boolean(b.querySelector('svg[data-icon="check"], [class*="check" i]'));
              return (
                (bTxt === 'yes' || bTxt.startsWith('yes') || bTxt.includes('confirm') || hasCheck) &&
                !bTxt.includes('no') &&
                !bTxt.includes('cancel')
              );
            });
            if (yes) {
              triggerClick(yes);
              return { confirmed: true, method: 'modal-yes-button' };
            }
          }

          return { confirmed: false };
        },
      });

      if (modalResult?.[0]?.result?.confirmed) {
        confirmed = true;
        break;
      }
    }

    await new Promise((r) => setTimeout(r, 600));
    return { success: true, confirmed };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Detects if active tab is on the Newton School assessments catalog page,
 * and extracts all quiz cards with solved vs unsolved statuses and XP details.
 *
 * @param {number} tabId
 * @returns {Promise<Object>}
 */
export async function detectAssessmentsCatalog(tabId) {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) {
    return { isCatalog: false, quizzes: [], total: 0, unsolvedCount: 0 };
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const currentUrl = window.location.href;
        const isCatalogUrl = currentUrl.includes('all_assessments') || currentUrl.includes('assessment');
        const container = document.querySelector(
          '.sc-ccf6239c-13.glpBZc, div.glpBZc, [class*="glpBZc"]'
        );
        const cards = Array.from(
          document.querySelectorAll('.sc-ccf6239c-3.kxmaFX, div.kxmaFX, [class*="kxmaFX"]')
        );

        if (!isCatalogUrl && !container && cards.length === 0) {
          return { isCatalog: false, currentUrl, quizzes: [], total: 0, unsolvedCount: 0 };
        }

        // Global solved counter from page header e.g. "9/51 Solved"
        const headerCountEl = document.querySelector(
          '.sc-20eba032-4.kmoWEW, [class*="kmoWEW"]'
        );
        const headerCountText = headerCountEl ? headerCountEl.innerText.trim() : '';

        const quizzes = cards.map((card, index) => {
          // Subject tag (e.g., "DL - C", "AML - C", "MCA - C")
          const subjectEl = card.querySelector(
            '.sc-ccf6239c-6.cykAEe, p.cykAEe, [class*="cykAEe"]'
          );
          const subject = subjectEl ? subjectEl.innerText.trim() : '';

          // Title and description
          const titleEl = card.querySelector(
            '.sc-ccf6239c-5.gHysLX, span.gHysLX, [class*="gHysLX"]'
          );
          const title = titleEl ? titleEl.innerText.trim() : '';

          // Date
          const dateEl = card.querySelector(
            '.sc-ccf6239c-7.fKIbyq, span.fKIbyq, [class*="fKIbyq"]'
          );
          const date = dateEl ? dateEl.innerText.trim() : '';

          // Status icon image
          const statusImg = card.querySelector('img[alt="status"], .sc-ccf6239c-8 img');
          const statusSrc = statusImg ? statusImg.getAttribute('src') || '' : '';

          // Newton School status SVG hashes
          // a9b7146bd5574b0cb3966bbb00b96033 -> Solved / completed
          // 0a568d419997457f9a3630c3cd98fdf7 -> Partial / in-progress
          // 0917b390a9214f029589d9f6c11e1438 -> Unattempted / unsolved
          const isSolvedSvg = statusSrc.includes('a9b7146bd5574b0cb3966bbb00b96033');
          const isPartialSvg = statusSrc.includes('0a568d419997457f9a3630c3cd98fdf7');
          const isUnattemptedSvg = statusSrc.includes('0917b390a9214f029589d9f6c11e1438');

          // XP Earned (e.g. 0/24, 4/18, 24/24)
          const xpEl = card.querySelector(
            '.sc-d8b25d64-3.kxcrNo, div.kxcrNo, [class*="kxcrNo"]'
          );
          const xpText = xpEl ? xpEl.innerText.trim() : '';
          let xpEarned = 0;
          let xpMax = 0;
          if (xpText.includes('/')) {
            const parts = xpText.split('/');
            xpEarned = parseInt(parts[0], 10) || 0;
            xpMax = parseInt(parts[1], 10) || 0;
          }

          // Topic badges
          const topicEls = Array.from(
            card.querySelectorAll(
              '.sc-ccf6239c-12.ica-dgv, span.ica-dgv, [class*="ica-dgv"]'
            )
          );
          const topics = topicEls.map((t) => t.innerText.trim()).filter(Boolean);

          // An assessment is strictly unsolved if it hasn't been completed:
          // 1. Not solved SVG
          // 2. Either 0 XP or unattempted SVG or xpText begins with 0/
          const isUnsolved =
            !isSolvedSvg &&
            (isUnattemptedSvg || xpEarned === 0 || (xpText.startsWith('0/') && xpMax > 0));

          const isSolved = isSolvedSvg || (xpEarned > 0 && xpEarned === xpMax);
          const isPartial = isPartialSvg || (xpEarned > 0 && xpEarned < xpMax);

          return {
            cardIndex: index,
            subject,
            title,
            date,
            xpText,
            xpEarned,
            xpMax,
            statusSrc,
            isSolved,
            isPartial,
            isUnsolved,
            topics,
          };
        });

        const unsolved = quizzes.filter((q) => q.isUnsolved);

        return {
          isCatalog: true,
          currentUrl,
          headerCountText,
          quizzes,
          total: quizzes.length,
          unsolvedCount: unsolved.length,
          unsolvedIndices: unsolved.map((q) => q.cardIndex),
        };
      },
    });

    return result?.[0]?.result || { isCatalog: false, quizzes: [], total: 0, unsolvedCount: 0 };
  } catch (err) {
    console.warn('detectAssessmentsCatalog error:', err);
    return { isCatalog: false, quizzes: [], total: 0, unsolvedCount: 0, error: err.message };
  }
}

/**
 * Clicks an assessment card in the catalog to open the quiz.
 *
 * @param {number} tabId
 * @param {number} cardIndex
 * @returns {Promise<Object>}
 */
export async function clickQuizCardOnCatalog(tabId, cardTarget = 0) {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) {
    return { success: false, error: 'Chrome scripting not available' };
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (target) => {
        const cards = Array.from(
          document.querySelectorAll('.sc-ccf6239c-3.kxmaFX, div.kxmaFX, [class*="kxmaFX"]')
        );
        if (!cards.length) {
          return { success: false, error: 'No assessment cards found on page' };
        }

        let card = null;

        // 1. If target is an object with title and subject
        if (typeof target === 'object' && target !== null) {
          const { title: targetTitle, subject: targetSubject, cardIndex: targetIdx } = target;

          if (targetTitle) {
            // Find by exact title & subject
            card = cards.find((c) => {
              const tEl = c.querySelector('.sc-ccf6239c-5.gHysLX, span.gHysLX, [class*="gHysLX"]');
              const sEl = c.querySelector('.sc-ccf6239c-6.cykAEe, p.cykAEe, [class*="cykAEe"]');
              const t = (tEl?.innerText || tEl?.textContent || '').trim();
              const s = (sEl?.innerText || sEl?.textContent || '').trim();
              if (targetSubject && s && s !== targetSubject) return false;
              return t === targetTitle;
            });

            // Find by title substring if exact match was not found
            if (!card) {
              card = cards.find((c) => {
                const tEl = c.querySelector('.sc-ccf6239c-5.gHysLX, span.gHysLX, [class*="gHysLX"]');
                const t = (tEl?.innerText || tEl?.textContent || '').trim();
                return t.includes(targetTitle) || targetTitle.includes(t);
              });
            }
          }

          if (!card && typeof targetIdx === 'number' && cards[targetIdx]) {
            card = cards[targetIdx];
          }
        } else if (typeof target === 'number' && cards[target]) {
          card = cards[target];
        }

        if (!card) {
          card = cards[0];
        }

        try {
          card.scrollIntoView({ behavior: 'instant', block: 'center' });
        } catch {}

        const titleEl = card.querySelector('.sc-ccf6239c-5.gHysLX, [class*="gHysLX"]');
        const subjectEl = card.querySelector('.sc-ccf6239c-6.cykAEe, [class*="cykAEe"]');
        const title = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : '';
        const subject = subjectEl ? (subjectEl.innerText || subjectEl.textContent || '').trim() : '';

        // Dispatch single clean click to the primary interactive element or the card container
        const targetEl = card.querySelector('a[href], button') || card;
        try {
          targetEl.scrollIntoView({ behavior: 'instant', block: 'center' });
        } catch {}

        let clicked = false;
        try {
          if (typeof targetEl.click === 'function') {
            targetEl.click();
            clicked = true;
          }
        } catch {}

        if (!clicked) {
          try {
            targetEl.dispatchEvent(
              new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window,
                detail: 1,
                button: 0,
              })
            );
          } catch {}
        }

        return { success: true, title, subject };
      },
      args: [cardTarget],
    });

    return result?.[0]?.result || { success: false, error: 'Execution returned no result' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Handles instructions or overview page by detecting and clicking "Start Assessment",
 * "Attempt Quiz", "Start Quiz", "Take Quiz", etc.
 *
 * @param {number} tabId
 * @returns {Promise<Object>}
 */
export async function handleStartOrInstructionsPage(tabId) {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) {
    return { handled: false };
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const startKeywords = [
          'start assessment',
          'attempt assessment',
          'attempt quiz',
          'start quiz',
          'start test',
          'take assessment',
          'take quiz',
          'take test',
          'resume assessment',
          'resume quiz',
          'continue assessment',
          'start now',
          'attempt now',
          'begin assessment',
          'begin quiz',
          'attempt',
          'start',
          'proceed',
          'continue',
        ];

        const allButtons = Array.from(
          document.querySelectorAll('button:not([disabled]), [role="button"]:not([disabled]), a:not([disabled])')
        );

        let targetBtn = allButtons.find((btn) => {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          return startKeywords.some((kw) => text === kw || (kw.length > 5 && text.includes(kw)));
        });

        if (!targetBtn) {
          const pageText = (document.body.innerText || document.body.textContent || '').toLowerCase();
          if (
            pageText.includes('instruction') ||
            pageText.includes('assessment overview') ||
            pageText.includes('quiz details') ||
            pageText.includes('total questions')
          ) {
            targetBtn = allButtons.find((btn) => {
              const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
              return (
                (text.includes('start') ||
                  text.includes('attempt') ||
                  text.includes('continue') ||
                  text.includes('resume')) &&
                !text.includes('back') &&
                !text.includes('download')
              );
            });
          }
        }

        if (targetBtn) {
          const btnText = (targetBtn.innerText || targetBtn.textContent || '').trim();
          try {
            targetBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          } catch {}

          let btnClicked = false;
          try {
            if (typeof targetBtn.click === 'function') {
              targetBtn.click();
              btnClicked = true;
            }
          } catch {}

          if (!btnClicked) {
            try {
              targetBtn.dispatchEvent(
                new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  detail: 1,
                  button: 0,
                })
              );
            } catch {}
          }

          return { handled: true, buttonText: btnText };
        }

        return { handled: false };
      },
    });

    return result?.[0]?.result || { handled: false };
  } catch (err) {
    return { handled: false, error: err.message };
  }
}

/**
 * Polls until quiz questions with radio options are actually rendered in the DOM.
 * Automatically handles instructions / start buttons if encountered during polling.
 *
 * @param {number} tabId
 * @param {number} [timeoutMs=20000]
 * @returns {Promise<Object>}
 */
export async function waitForQuizQuestionsToLoad(tabId, timeoutMs = 20000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // 1. Check if instructions/start button is on page, and click it
    await handleStartOrInstructionsPage(tabId);

    // 2. Check if radio questions are present in DOM
    try {
      const domData = await extractQuizQuestionsFromPage(tabId, true);
      if (domData?.questions?.length > 0) {
        return { ready: true, questionCount: domData.questions.length };
      }
    } catch (err) {
      console.warn('waitForQuizQuestionsToLoad polling warning:', err.message);
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  return { ready: false, timeout: true };
}

/**
 * Navigates from a submitted quiz page back to the assessments catalog.
 * Tries on-page Back button first for instant Next.js routing, and falls back to catalogUrl.
 *
 * @param {number} tabId
 * @param {string} catalogUrl
 * @returns {Promise<Object>}
 */
export async function navigateBackToCatalog(tabId, catalogUrl) {
  if (typeof chrome === 'undefined' || !tabId) {
    return { success: false, error: 'Chrome tab not available' };
  }

  try {
    // 1. Try clicking the breadcrumb "Back" button on page
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const backBtn =
          document.querySelector('button.sc-ec795657-0.iLreVt') ||
          document.querySelector('button[class*="iLreVt"]') ||
          Array.from(document.querySelectorAll('button')).find((b) => {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            return txt === 'back' || txt.includes('back');
          });

        if (backBtn) {
          try {
            backBtn.click();
          } catch {}
          return { clicked: true };
        }

        if (window.history.length > 1) {
          window.history.back();
          return { historyBack: true };
        }
        return { clicked: false };
      },
    });

    // 2. Poll up to 3s to see if catalog cards re-appear
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const checkRes = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const cards = document.querySelectorAll('.sc-ccf6239c-3, [class*="kxmaFX"]');
          return cards.length > 0 && window.location.href.includes('all_assessments');
        },
      });
      if (checkRes?.[0]?.result) {
        return { success: true, method: 'back-button' };
      }
    }

    // 3. Fallback: navigate directly to catalogUrl
    if (catalogUrl) {
      await chrome.tabs.update(tabId, { url: catalogUrl });
      // Wait for catalog cards to re-render
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const checkRes = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const cards = document.querySelectorAll('.sc-ccf6239c-3, [class*="kxmaFX"]');
            return cards.length > 0;
          },
        });
        if (checkRes?.[0]?.result) {
          return { success: true, method: 'url-navigation' };
        }
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Waits for the catalog page to finish rendering cards.
 *
 * @param {number} tabId
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<Object>}
 */
export async function waitForCatalogToLoad(tabId, timeoutMs = 10000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const catalogInfo = await detectAssessmentsCatalog(tabId);
    if (catalogInfo?.isCatalog && catalogInfo?.total > 0) {
      return { ready: true, catalogInfo };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ready: false, timeout: true };
}

