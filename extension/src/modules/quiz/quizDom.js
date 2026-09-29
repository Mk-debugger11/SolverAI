/**
 * Quiz DOM Module: Handles all DOM extraction, KaTeX math rendering,
 * precision option selection, navigation, and submission confirmation on the active webpage.
 */

/**
 * Extracts radio and editable numerical questions from the active tab.
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
    func: async (isLightweight) => {
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

        clone.querySelectorAll('svg').forEach((s) => s.remove());
        clone.querySelectorAll('math').forEach((math) => {
          const value = (math.getAttribute('alttext') || math.textContent || '').trim();
          if (value) math.parentNode?.replaceChild(document.createTextNode(` ${value} `), math);
          else math.remove();
        });
        return (clone.innerText || clone.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
      };

      // Preserve diagrams in the solver payload. Failed extraction is explicit:
      // solving the text alone can change the question's meaning.
      const extractImages = async (root) => {
        const images = [];
        const rasterize = (node, width, height) => {
          const scale = Math.min(1, 500 / Math.max(width, height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas rendering is unavailable.');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(node, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', 0.8);
        };
        try {
          for (const node of root?.querySelectorAll?.('img, svg') || []) {
            const tag = node.tagName.toLowerCase();
            const rect = node.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            const src = node.currentSrc || node.src || node.getAttribute('src') || '';
            if (/^(?:status|avatar|user avatar|logo|profile picture)$/i.test(node.alt || '') || /avatar|profile|questionStatus\//i.test(src)) continue;
            let data;
            if (tag === 'img') {
              if (!src) throw new Error('A question image has no source.');
              try { data = rasterize(node, node.naturalWidth || rect.width, node.naturalHeight || rect.height); }
              catch {
                if (/^https?:/i.test(src) && !/\.svg(?:[?#]|$)/i.test(src) || /^data:image\/(?:jpeg|png|webp);base64,/i.test(src)) data = src;
                else throw new Error('A question image could not be read.');
              }
            } else {
              if (rect.width < 50 || rect.height < 50 || node.closest?.('.katex, .katex-html') ||
                  node.querySelectorAll('circle, path, line, rect, text, polygon').length < 2) continue;
              const blob = new Blob([new XMLSerializer().serializeToString(node)], { type: 'image/svg+xml;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              try {
                data = await new Promise((resolve, reject) => {
                  const img = new Image();
                  const timer = setTimeout(() => { img.onload = null; img.onerror = null; reject(new Error('A question diagram did not render in time.')); }, 1000);
                  img.onload = () => {
                    clearTimeout(timer);
                    try { resolve(rasterize(img, rect.width, rect.height)); } catch (error) { reject(error); }
                  };
                  img.onerror = () => { clearTimeout(timer); reject(new Error('A question diagram could not be rendered.')); };
                  img.src = url;
                });
              } finally { URL.revokeObjectURL(url); }
            }
            if (data && !images.includes(data)) images.push(data);
            if (images.length > 3) throw new Error('The question has more than three images; its visual content cannot be discarded.');
          }
          return images.length ? { images } : {};
        } catch (error) { return { images, imageExtractionError: error.message }; }
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
      const questionElements = new Map();

      for (const [gIdx, [groupName, radios]] of Object.entries(groups).entries()) {
        if (!radios.length) continue;

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

        // Unstyled badges are safe to strip only when every label repeats the
        // same leading A/B/C sequence and has a separate choice-text sibling.
        const leadingLabelParts = (label) => Array.from(label?.children || []).filter(
          (child) => child.tagName?.toLowerCase() !== 'input' && (child.textContent || '').trim()
        );
        const hasSequentialBadges = radios.length > 1 && radios.every((radio, index) => {
          const parts = leadingLabelParts(radio.closest('label'));
          return parts.length > 1 && !parts[0].children.length &&
            (parts[0].textContent || '').trim() === String.fromCharCode(65 + index);
        });
        const options = radios.map((radio, rIdx) => {
          let labelText = '';
          let labelEl = radio.closest('label');
          if (!labelEl && radio.id) {
            try {
              labelEl = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
            } catch {}
          }

          const badgeLetter = String.fromCharCode(65 + rIdx);

          if (labelEl) {
            const labelClone = labelEl.cloneNode(true);
            labelClone.querySelectorAll('input[type="radio"], svg').forEach((el) => el.remove());
            // Strip only a dedicated badge; a lone math/code variable is content.
            const cloneCandidates = Array.from(
              labelClone.querySelectorAll(
                '.kuwkNu, .bIKUCi, [class*="kuwkNu"], [class*="bIKUCi"], [class*="badge" i], [class*="letter" i]'
              )
            );
            if (!cloneCandidates.length && hasSequentialBadges) {
              const leading = leadingLabelParts(labelClone)[0];
              if (leading) cloneCandidates.push(leading);
            }
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

          const cleanText = labelText.trim();

          // Multi-signal detection if this option is already selected on page
          let isSelected = Boolean(radio.checked);
          if (!isLightweight && !isSelected && labelEl) {
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

        const visual = await extractImages(commonParent);
        const question = {
          answerType: 'mcq',
          questionIndex: gIdx + 1,
          questionId,
          questionText,
          groupName,
          options,
          ...visual,
          llmPayload: {
            q: questionText,
            o: optionsMap,
            ...(visual.images?.length ? { images: visual.images } : {}),
          },
        };
        extractedQuestions.push(question);
        questionElements.set(question, questionEl || radios[0]);

        if (!isLightweight && commonParent && !parentContainerElements.includes(commonParent)) {
          parentContainerElements.push(commonParent);
        }
      }

      // Numerical fields must belong to a question block. The puzzle marker and
      // block class are used by Newton's editable revision view as well as quizzes.
      const numericContainerSelector = '.sc-8f773ddd-5, [data-question-id], [data-testid="question-container"], [data-testid="question"]';
      const numericHeadingSelector = '.text-span-question-renderer, [class*="text-span-question-renderer"], [data-testid="question-text"], [data-testid="question-stem"]';
      const normalizeText = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const isVisible = (el) => Boolean(
        el && !el.closest('[hidden], [aria-hidden="true"], [inert]') &&
        el.getClientRects().length &&
        !['hidden', 'collapse'].includes(window.getComputedStyle(el).visibility)
      );
      const isNumericField = (input) => {
        const type = input.type.toLowerCase();
        if (!['text', 'number'].includes(type) || input.disabled || input.readOnly || input.matches(':disabled')) return false;
        const hints = [input.name, input.id, input.placeholder, input.getAttribute('aria-label'), input.autocomplete].join(' ');
        if (/\b(search|filter|email|username|password|login|phone|tel|otp|one-time-code)\b/i.test(hints)) return false;
        const numericHint = input.hasAttribute('data-puzzle-answer') || type === 'number' ||
          ['numeric', 'decimal'].includes(input.inputMode) ||
          /\b(answer|numeric|numerical|number)\b/i.test(`${hints} ${Array.from(input.labels || []).map(normalizeText).join(' ')}`);
        return numericHint && isVisible(input);
      };
      const elementPath = (el) => {
        const path = [];
        while (el && el !== document.body) {
          const parent = el.parentElement;
          if (!parent) return null;
          path.unshift(Array.prototype.indexOf.call(parent.children, el));
          el = parent;
        }
        return el === document.body ? path : null;
      };
      const seenNumericContainers = new Set();
      for (const input of document.querySelectorAll('input[type="number"], input[type="text"], input:not([type])')) {
        if (!isNumericField(input)) continue;
        const container = input.closest(numericContainerSelector);
        if (!container || seenNumericContainers.has(container)) continue;
        seenNumericContainers.add(container);
        // A radio question's ancillary text field, or several answer fields, is
        // ambiguous. Neither is safe to treat as a single numerical answer.
        if (container.querySelector('input[type="radio"], input[type="checkbox"]')) continue;
        const fields = Array.from(container.querySelectorAll('input')).filter(isNumericField);
        if (fields.length !== 1) continue;
        const headings = Array.from(container.querySelectorAll(numericHeadingSelector))
          .filter(isVisible)
          .filter((heading, _index, all) => !all.some((other) => other !== heading && heading.contains(other)));
        if (headings.length !== 1) continue;
        const heading = headings[0];
        const questionText = extractCleanMathText(heading);
        const inputPath = elementPath(input);
        const questionPath = elementPath(heading);
        const containerPath = elementPath(container);
        if (!questionText || !inputPath || !questionPath || !containerPath) continue;
        const questionIdentity = [heading.id, heading.getAttribute('data-question-id'), heading.getAttribute('data-id'),
          container.id, container.getAttribute('data-question-id'), container.getAttribute('data-id')].map((value) => value || '');
        const questionId = input.id || questionIdentity.find(Boolean) || input.name || `numeric_question_${extractedQuestions.length + 1}`;
        const inputValue = input.value;
        const targetDescriptor = {
          kind: 'numeric',
          id: input.id || '',
          name: input.name || '',
          type: input.type,
          inputMode: input.inputMode || '',
          placeholder: input.placeholder || '',
          puzzleAnswer: input.hasAttribute('data-puzzle-answer'),
          pageUrl: window.location.href,
          questionId,
          questionText,
          questionDomText: normalizeText(heading),
          questionIdentity,
          inputPath,
          questionPath,
          containerPath,
          inputValue,
        };
        const visual = await extractImages(container);
        const question = {
          answerType: 'numeric', questionId, questionText, options: [], inputValue, targetDescriptor,
          ...visual,
          llmPayload: { q: questionText, answerType: 'numeric', ...(visual.images?.length ? { images: visual.images } : {}) },
        };
        extractedQuestions.push(question);
        questionElements.set(question, heading);
        if (!isLightweight) parentContainerElements.push(container);
      }

      // Revision pages can mount a numerical question before several MCQs.
      // Preserve that order instead of putting all radio groups first.
      if (extractedQuestions.some((question) => question.answerType === 'numeric')) {
        extractedQuestions.sort((a, b) => {
          const position = questionElements.get(a).compareDocumentPosition(questionElements.get(b));
          return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
        });
        extractedQuestions.forEach((question, index) => { question.questionIndex = index + 1; });
      }

      const onlyRadioContainersHtml = isLightweight ? '' : parentContainerElements
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

/** Fill one numerical answer only while its question and prior value still match. */
export async function fillQuizNumericAnswerOnPage(tabId, targetDescriptor, answer) {
  const numericValue = typeof answer === 'string' || typeof answer === 'number' ? String(answer).trim() : '';
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numericValue) || !Number.isFinite(Number(numericValue))) {
    return { success: false, failureReason: 'The answer must be a finite decimal or scientific-notation number.' };
  }
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId || targetDescriptor?.kind !== 'numeric') {
    return { success: false, failureReason: 'The numerical input or Chrome tab is unavailable.' };
  }

  try {
    const current = await extractQuizQuestionsFromPage(tabId, true);
    const matches = current.questions.filter((question) => question.answerType === 'numeric' &&
      JSON.stringify(question.targetDescriptor) === JSON.stringify(targetDescriptor));
    if (matches.length !== 1) {
      return { success: false, failureReason: 'The numerical question or its input value changed while waiting.' };
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [targetDescriptor, numericValue],
      func: async (desc, answerText) => {
        const failure = (failureReason) => ({ success: false, failureReason });
        try {
          const resolvePath = (path) => path.reduce((element, index) => element?.children[index], document.body);
          const normalizeText = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
          const locate = () => {
            if (window.location.href !== desc.pageUrl) return null;
            const input = resolvePath(desc.inputPath);
            const heading = resolvePath(desc.questionPath);
            const container = resolvePath(desc.containerPath);
            if (!(input instanceof HTMLInputElement) || !heading || !container ||
                !container.contains(input) || !container.contains(heading) ||
                input.disabled || input.readOnly || input.matches(':disabled') ||
                input.closest('[hidden], [aria-hidden="true"], [inert]') || !input.getClientRects().length ||
                ['hidden', 'collapse'].includes(window.getComputedStyle(input).visibility)) return null;
            const identity = [heading.id, heading.getAttribute('data-question-id'), heading.getAttribute('data-id'),
              container.id, container.getAttribute('data-question-id'), container.getAttribute('data-id')].map((value) => value || '');
            if (input.id !== desc.id || input.name !== desc.name || input.type !== desc.type ||
                (input.inputMode || '') !== desc.inputMode || (input.placeholder || '') !== desc.placeholder ||
                input.hasAttribute('data-puzzle-answer') !== desc.puzzleAnswer ||
                normalizeText(heading) !== desc.questionDomText || JSON.stringify(identity) !== JSON.stringify(desc.questionIdentity)) return null;
            return input;
          };
          const input = locate();
          if (!input || input.value !== desc.inputValue) return failure('The numerical question or its input value changed before filling.');
          // Native number inputs reject a leading +, a leading decimal point,
          // or a trailing decimal point even though those are valid numbers.
          const value = input.type === 'number' ? answerText.replace(/^\+/, '').replace(/^(-?)\./, (_match, sign) => `${sign}0.`).replace(/\.(?=[eE]|$)/, '') : answerText;
          if (input.maxLength >= 0 && value.length > input.maxLength) return failure('The answer exceeds the input length limit.');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (!setter) return failure('The browser does not expose a native input value setter.');
          input.focus({ preventScroll: true });
          if (locate() !== input || input.value !== desc.inputValue) return failure('The numerical question or its input changed on focus.');
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
          // React may replace or revert the input after its event handlers run.
          // Resolve the live element again; never force a value during verification.
          await new Promise((resolve) => setTimeout(resolve, 150));
          const liveInput = locate();
          if (!liveInput || liveInput.value !== value || liveInput.validity?.valid === false) {
            return failure('The page did not retain the numerical answer after updating.');
          }
          return { success: true, value: liveInput.value };
        } catch (error) {
          return failure(`Could not fill the numerical answer: ${error.message}`);
        }
      },
    });
    return results?.[0]?.result || { success: false, failureReason: 'Script execution returned no result.' };
  } catch (error) {
    return { success: false, failureReason: `Could not fill the numerical answer: ${error.message}` };
  }
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

        // Extraction assigns canonical A/B/C keys in DOM order. Resolve that
        // exact group position before considering any text inside the choice.
        const letterIndex = targetLetter ? targetLetter.charCodeAt(0) - 65 : -1;
        const optionIndex = typeof desc?.index === 'number' && desc.index >= 0
          ? desc.index : letterIndex >= 0 ? letterIndex : fallbackIndex;
        if (Number.isInteger(optionIndex) && optionIndex >= 0 && groupRadios[optionIndex]) {
          target = groupRadios[optionIndex];
          matchedBy = `group_index_${optionIndex}`;
        }

        if (!target && targetLetter && groupRadios.length > 0) {
          for (const radio of groupRadios) {
            const label = radio.closest('label') || document.querySelector(`label[for="${CSS.escape(radio.id || '')}"]`);
            const badge = label?.querySelector(
              '.kuwkNu, .bIKUCi, [class*="kuwkNu"], [class*="bIKUCi"], [class*="badge" i], [class*="letter" i]'
            );
            if (badge && (badge.textContent || '').trim().toUpperCase() === targetLetter) {
              target = radio;
              matchedBy = `badge_letter_${targetLetter}`;
              break;
            }
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
          return /question\s*\d+\s*(?:\/|of)\s*\d+/i.test(text) && el.children.length === 0;
        });

        if (counterEl) {
          const match = (counterEl.innerText || '').match(/question\s*(\d+)\s*(?:\/|of)\s*(\d+)/i);
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
          return /question\s*\d+\s*(?:\/|of)\s*\d+/i.test(text) && el.children.length === 0;
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
        const isCatalogUrl = /\/all_assessments\/?$/.test(window.location.pathname);
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
 * "Attempt Quiz", "Start Quiz", "Take Quiz", "Start Test", etc.
 *
 * @param {number} tabId
 * @returns {Promise<Object>}
 */
export async function handleStartOrInstructionsPage(tabId) {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) {
    return { handled: false };
  }

  const executeStartClick = () => {
    const primaryPhrases = [
      'start test',
      'start assessment',
      'start quiz',
      'attempt quiz',
      'attempt test',
      'attempt assessment',
      'take test',
      'take quiz',
      'take assessment',
      'begin test',
      'begin quiz',
      'begin assessment',
      'resume test',
      'resume quiz',
      'resume assessment',
    ];

    const cleanText = (el) => ((el && (el.innerText || el.textContent || el.value)) || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // 1. Interactive candidate elements
    const interactive = Array.from(
      document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')
    ).filter((el) => !el.disabled && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true');

    // Tier 1: Exact phrase on interactive element
    let target = interactive.find((el) => primaryPhrases.includes(cleanText(el)));

    // Tier 2: Check child elements (span, div, b, strong) whose direct text is exact phrase
    if (!target) {
      const textNodes = Array.from(document.querySelectorAll('button, span, div, b, strong, p, a'));
      for (const el of textNodes) {
        const t = cleanText(el);
        if (primaryPhrases.includes(t)) {
          const parentBtn = el.closest('button, [role="button"], a, [tabindex="0"]');
          if (parentBtn && !parentBtn.disabled && !parentBtn.hasAttribute('disabled') && parentBtn.getAttribute('aria-disabled') !== 'true') {
            target = parentBtn;
            break;
          }
          target = el;
          break;
        }
      }
    }

    // Tier 3: XPath queries for case-insensitive exact and contains matches
    if (!target) {
      const xpathQueries = [
        "//button[normalize-space(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']",
        "//*[@role='button'][normalize-space(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']",
        "//a[normalize-space(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']",
        "//*[normalize-space(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']/ancestor-or-self::button",
        "//*[normalize-space(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']/ancestor-or-self::*[@role='button' or self::button or self::a]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'start test')]",
        "//*[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'start test')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'start assessment')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'attempt quiz')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'take test')]",
      ];

      for (const query of xpathQueries) {
        try {
          const snap = document.evaluate(query, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          if (snap && snap.singleNodeValue) {
            const node = snap.singleNodeValue;
            if (!node.hasAttribute?.('disabled') && node.getAttribute?.('aria-disabled') !== 'true') {
              target = node;
              break;
            }
          }
        } catch {}
      }
    }

    // Tier 4: Assessment Overview card context detection
    if (!target) {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const isOverviewPage =
        bodyText.includes('test syllabus') ||
        bodyText.includes('playlist title') ||
        bodyText.includes('number of questions') ||
        bodyText.includes('total xp') ||
        bodyText.includes('scheduled for');

      if (isOverviewPage) {
        const overviewButtons = interactive.filter((b) => {
          const text = cleanText(b);
          return !/\b(back|download|logout|cancel|close|submit)\b/.test(text);
        });

        // 4a. Button text containing 'start' or 'attempt' or 'take'
        target = overviewButtons.find((b) => {
          const text = cleanText(b);
          return (text.includes('start') && text.includes('test')) || text.includes('start') || text.includes('attempt') || text.includes('take');
        });

        // 4b. Primary green button on overview page
        if (!target) {
          target = overviewButtons.find((b) => {
            try {
              const bg = window.getComputedStyle(b).backgroundColor || '';
              const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
              if (match) {
                const r = parseInt(match[1], 10);
                const g = parseInt(match[2], 10);
                const bVal = parseInt(match[3], 10);
                if (g > 100 && g > r * 1.3 && g > bVal * 1.3) return true;
              }
            } catch {}
            return false;
          });
        }

        // 4c. Single actionable button on overview card
        if (!target && overviewButtons.length === 1) {
          target = overviewButtons[0];
        }
      }
    }

    // Tier 5: Fallback to exact 'start' or 'attempt' or 'begin'
    if (!target) {
      const fallbacks = ['start', 'attempt', 'begin', 'launch', 'proceed'];
      target = interactive.find((b) => fallbacks.includes(cleanText(b)));
    }

    if (!target) {
      return { handled: false };
    }

    const clickableTarget = target.closest('button, [role="button"], a, input[type="button"], input[type="submit"]') || target;
    const btnText = (clickableTarget.innerText || clickableTarget.textContent || clickableTarget.value || 'Start Test').replace(/\s+/g, ' ').trim();

    // Scroll into view & focus
    try {
      clickableTarget.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    } catch {}
    try {
      clickableTarget.focus?.();
    } catch {}

    // Compute coordinates
    let clientX = 100;
    let clientY = 100;
    try {
      const rect = clickableTarget.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        clientX = Math.round(rect.x + rect.width / 2);
        clientY = Math.round(rect.y + rect.height / 2);
      }
    } catch {}

    const commonOpts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      buttons: 1,
    };

    // Dispatch Pointer Events
    if (typeof window.PointerEvent === 'function') {
      try {
        clickableTarget.dispatchEvent(new PointerEvent('pointerover', { ...commonOpts, pointerId: 1, pointerType: 'mouse' }));
        clickableTarget.dispatchEvent(new PointerEvent('pointerenter', { ...commonOpts, pointerId: 1, pointerType: 'mouse' }));
        clickableTarget.dispatchEvent(new PointerEvent('pointerdown', { ...commonOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      } catch {}
    }

    // Dispatch Mouse Events
    try {
      clickableTarget.dispatchEvent(new MouseEvent('mouseover', commonOpts));
      clickableTarget.dispatchEvent(new MouseEvent('mousedown', commonOpts));
    } catch {}

    if (typeof window.PointerEvent === 'function') {
      try {
        clickableTarget.dispatchEvent(new PointerEvent('pointerup', { ...commonOpts, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      } catch {}
    }

    try {
      clickableTarget.dispatchEvent(new MouseEvent('mouseup', { ...commonOpts, buttons: 0 }));
      clickableTarget.dispatchEvent(new MouseEvent('click', { ...commonOpts, buttons: 0 }));
    } catch {}

    // Native .click()
    try {
      if (typeof clickableTarget.click === 'function') {
        clickableTarget.click();
      }
    } catch {}

    if (target !== clickableTarget) {
      try {
        if (typeof target.click === 'function') {
          target.click();
        }
      } catch {}
    }

    // React Fiber Props onClick direct invocation
    const elementsToCheck = [
      clickableTarget,
      target,
      ...Array.from(clickableTarget.querySelectorAll('*')).slice(0, 5),
      clickableTarget.parentElement,
      clickableTarget.parentElement?.parentElement,
    ].filter(Boolean);

    for (const el of elementsToCheck) {
      try {
        const propKey = Object.keys(el).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
        if (propKey && el[propKey]) {
          const props = el[propKey];
          if (typeof props.onClick === 'function') {
            props.onClick({
              preventDefault: () => {},
              stopPropagation: () => {},
              stopImmediatePropagation: () => {},
              target: el,
              currentTarget: el,
              nativeEvent: new MouseEvent('click', commonOpts),
              persist: () => {},
            });
            break;
          }
        }
      } catch {}
    }

    // Anchor link href fallback
    if (clickableTarget.tagName === 'A' && clickableTarget.href && !clickableTarget.href.startsWith('javascript:')) {
      try {
        const curUrl = window.location.href;
        setTimeout(() => {
          if (window.location.href === curUrl && clickableTarget.href !== curUrl) {
            window.location.assign(clickableTarget.href);
          }
        }, 300);
      } catch {}
    }

    return { handled: true, buttonText: btnText || 'Start Test' };
  };

  try {
    let result;
    try {
      result = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: executeStartClick,
      });
    } catch {
      result = await chrome.scripting.executeScript({
        target: { tabId },
        func: executeStartClick,
      });
    }

    return result?.[0]?.result || { handled: false };
  } catch (err) {
    return { handled: false, error: err.message };
  }
}

/**
 * Detects if the current active tab is on an assessment overview / launch page
 * with a "Start Test" or "Start Assessment" button, extracting quiz metadata.
 *
 * @param {number} tabId
 * @returns {Promise<Object>}
 */
export async function detectQuizStartPage(tabId) {
  if (typeof chrome === 'undefined' || !chrome.scripting || !tabId) {
    return { isStartPage: false };
  }

  const executeDetectStartPage = () => {
    const primaryPhrases = [
      'start test',
      'start assessment',
      'start quiz',
      'attempt quiz',
      'attempt test',
      'attempt assessment',
      'take test',
      'take quiz',
      'take assessment',
      'begin test',
      'begin quiz',
      'begin assessment',
      'resume test',
      'resume quiz',
      'resume assessment',
    ];

    const cleanText = (el) => ((el && (el.innerText || el.textContent || el.value)) || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    const bodyText = (document.body?.innerText || '').toLowerCase();
    const hasQuizMetadata =
      bodyText.includes('test syllabus') ||
      bodyText.includes('playlist title') ||
      bodyText.includes('number of questions') ||
      bodyText.includes('total xp') ||
      bodyText.includes('scheduled for');

    // Interactive elements
    const interactive = Array.from(
      document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')
    ).filter((el) => !el.disabled && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true');

    let target = interactive.find((el) => primaryPhrases.includes(cleanText(el)));

    if (!target) {
      const textNodes = Array.from(document.querySelectorAll('button, span, div, b, strong, p, a'));
      for (const el of textNodes) {
        const t = cleanText(el);
        if (primaryPhrases.includes(t)) {
          const parentBtn = el.closest('button, [role="button"], a, [tabindex="0"]');
          if (parentBtn && !parentBtn.disabled && !parentBtn.hasAttribute('disabled') && parentBtn.getAttribute('aria-disabled') !== 'true') {
            target = parentBtn;
            break;
          }
          target = el;
          break;
        }
      }
    }

    if (!target) {
      const xpathQueries = [
        "//button[normalize-space(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']",
        "//*[@role='button'][normalize-space(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']",
        "//a[normalize-space(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']",
        "//*[normalize-space(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']/ancestor-or-self::button",
        "//*[normalize-space(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))='start test']/ancestor-or-self::*[@role='button' or self::button or self::a]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'start test')]",
        "//*[@role='button'][contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'start test')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'start assessment')]",
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'attempt quiz')]",
      ];

      for (const query of xpathQueries) {
        try {
          const snap = document.evaluate(query, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          if (snap && snap.singleNodeValue) {
            const node = snap.singleNodeValue;
            if (!node.hasAttribute?.('disabled') && node.getAttribute?.('aria-disabled') !== 'true') {
              target = node;
              break;
            }
          }
        } catch {}
      }
    }

    if (!target && hasQuizMetadata) {
      const overviewButtons = interactive.filter((b) => {
        const text = cleanText(b);
        return !/\b(back|download|logout|cancel|close|submit)\b/.test(text);
      });

      target = overviewButtons.find((b) => {
        const text = cleanText(b);
        return (text.includes('start') && text.includes('test')) || text.includes('start') || text.includes('attempt') || text.includes('take');
      });

      if (!target) {
        target = overviewButtons.find((b) => {
          try {
            const bg = window.getComputedStyle(b).backgroundColor || '';
            const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (match) {
              const r = parseInt(match[1], 10);
              const g = parseInt(match[2], 10);
              const bVal = parseInt(match[3], 10);
              if (g > 100 && g > r * 1.3 && g > bVal * 1.3) return true;
            }
          } catch {}
          return false;
        });
      }

      if (!target && overviewButtons.length === 1) {
        target = overviewButtons[0];
      }
    }

    if (target || hasQuizMetadata) {
      const qCountMatch = bodyText.match(/(\d+)\s+questions/i);
      const questionCount = qCountMatch ? parseInt(qCountMatch[1], 10) : null;

      const xpMatch = bodyText.match(/total\s*xp\s*(\d+)/i) || bodyText.match(/(\d+)\s*xp/i);
      const totalXp = xpMatch ? parseInt(xpMatch[1], 10) : null;

      // Extract Playlist Title
      let playlistTitle = '';
      const playlistEl = Array.from(document.querySelectorAll('div, p, span, h1, h2, h3, h4')).find((el) => {
        return (el.innerText || '').toLowerCase().includes('playlist title');
      });
      if (playlistEl) {
        const nextEl = playlistEl.nextElementSibling || playlistEl.parentElement?.querySelector('h1, h2, h3, h4, p:not(:first-child)');
        if (nextEl) {
          playlistTitle = (nextEl.innerText || nextEl.textContent || '').trim();
        }
      }

      const btnText = target
        ? ((target.innerText || target.textContent || target.value || 'Start Test').replace(/\s+/g, ' ').trim())
        : 'Start Test';

      return {
        isStartPage: true,
        buttonText: btnText,
        questionCount,
        totalXp,
        playlistTitle,
      };
    }

    return { isStartPage: false };
  };

  try {
    let result;
    try {
      result = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: executeDetectStartPage,
      });
    } catch {
      result = await chrome.scripting.executeScript({
        target: { tabId },
        func: executeDetectStartPage,
      });
    }

    return result?.[0]?.result || { isStartPage: false };
  } catch {
    return { isStartPage: false };
  }
}

/**
 * Polls until radio or editable numerical questions are rendered in the DOM.
 * Automatically handles instructions / start buttons if encountered during polling.
 *
 * @param {number} tabId
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<Object>}
 */
export async function waitForQuizQuestionsToLoad(tabId, timeoutMs = 30000, isRunning = () => true) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs && isRunning()) {
    // Give React time to mount after Start, and check cancellation before retrying.
    const startResult = await handleStartOrInstructionsPage(tabId);
    if (!isRunning()) return { ready: false, cancelled: true };
    if (startResult?.handled) await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!isRunning()) return { ready: false, cancelled: true };

    // Check if supported questions are present in DOM
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
