/**
 * Copyright 2019 AXA Group Operations S.A.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parseString } from 'xml2js';
import { Cleaner } from '../../Cleaner';
import { Orchestrator } from '../../Orchestrator';
import { Config } from '../../types/Config';
import {
  BoundingBox,
  Character,
  Document,
  Element,
  Font,
  Image,
  Page,
  Word,
} from '../../types/DocumentRepresentation';
import { PdfminerFigure } from '../../types/PdfminerFigure';
import { PdfminerPage } from '../../types/PdfminerPage';
import { PdfminerText } from '../../types/PdfminerText';
import { PdfminerTextline } from '../../types/PdfminerTextline';
import * as utils from '../../utils';
import logger from '../../utils/Logger';
import { AbbyyTools } from '../abbyy/AbbyyTools';
import { TesseractExtractor } from '../tesseract/TesseractExtractor';

/**
 * Executes the pdfminer extraction function, reading an input pdf file and extracting a document representation.
 * This function involves recovering page contents like words, bounding boxes, fonts and other information that
 * the pdfminer tool's output provides. This function spawns the externally existing pdfminer tool.
 *
 * @param pdfInputFile The path including the name of the pdf file for input.
 * @returns The promise of a valid document (in the format DocumentRepresentation).
 */
export function execute(pdfInputFile: string, config: Config): Promise<Document> {
  return new Promise<Document>((resolveDocument, rejectDocument) => {
    return repairPdf(pdfInputFile).then(repairedPdf => {
      const xmlOutputFile: string = utils.getTemporaryFile('.xml');
      const imgsLocation: string = utils.getTemporaryDirectory();
      let pdf2txtLocation: string = utils.getCommandLocationOnSystem('pdf2txt.py');
      if (!pdf2txtLocation) {
        pdf2txtLocation = utils.getCommandLocationOnSystem('pdf2txt');
      }
      if (!pdf2txtLocation) {
        logger.debug(
          `Unable to find pdf2txt, the pdfminer executable on the system. Are you sure it is installed?`,
        );
      } else {
        logger.debug(`pdf2txt was found at ${pdf2txtLocation}`);
      }
      logger.info(`Extracting PDF contents using pdfminer...`);
      logger.debug(
        `${pdf2txtLocation} ${[
          '-c',
          'utf-8',
          // '-A', crashes pdf2txt.py using Benchmark axa.uk.business.owntools.pdf
          '-t',
          'xml',
          '-O',
          imgsLocation,
          '-o',
          xmlOutputFile,
          repairedPdf,
        ].join(' ')}`,
      );

      if (!fs.existsSync(xmlOutputFile)) {
        fs.appendFileSync(xmlOutputFile, '');
      }

      const pdfminer = spawn(pdf2txtLocation, [
        '-c',
        'utf-8',
        // '-A', crashes pdf2txt.py using Benchmark axa.uk.business.owntools.pdf
        '-t',
        'xml',
        '-O',
        imgsLocation,
        '-o',
        xmlOutputFile,
        repairedPdf,
      ]);

      pdfminer.stderr.on('data', data => {
        logger.error('pdfminer error:', data.toString('utf8'));
      });

      function parseXmlToObject(xml: string): Promise<object> {
        const promise = new Promise<object>((resolveObject, rejectObject) => {
          parseString(xml, { attrkey: '_attr' }, (error, dataObject) => {
            if (error) {
              rejectObject(error);
            }
            resolveObject(dataObject);
          });
        });
        return promise;
      }

      pdfminer.on('close', async code => {
        if (code === 0) {
          const xml: string = fs.readFileSync(xmlOutputFile, 'utf8');
          try {
            logger.debug(`Converting pdfminer's XML output to JS object..`);
            parseXmlToObject(xml).then(async (obj: any) => {
              const pagePromises: Array<Promise<Page>> = obj.pages.page.map(
                (pageObj: PdfminerPage) => getPage(pageObj, imgsLocation, config),
              );
              resolveDocument(new Document(await Promise.all(pagePromises), pdfInputFile));
              logger.debug(`...............RESOLVING DOCUMENT.............`);
            });
          } catch (err) {
            rejectDocument(`parseXml failed: ${err}`);
          }
        } else {
          rejectDocument(`pdfminer return code is ${code}`);
        }
      });
      // return doc;
    });
  });
}

async function getPage(pageObj: PdfminerPage, imagsLocation: string, config: Config): Promise<Page> {
  const boxValues: number[] = pageObj._attr.bbox.split(',').map(v => parseFloat(v));
  const pageBBox: BoundingBox = new BoundingBox(
    boxValues[0],
    boxValues[1],
    boxValues[2],
    boxValues[3],
  );

  let elements: Element[] = [];

  // treat paragraphs
  if (pageObj.textbox !== undefined) {
    pageObj.textbox.forEach(para => {
      para.textline.map(line => {
        elements = [...elements, ...breakLineIntoWords(line, ',', pageBBox.height)];
      });
    });
  }

  // treat figures
  const imgOCRPromises: Array<Promise<Document>> = [];
  if (pageObj.figure !== undefined) {
    const imageExtractionConfig: Config = new Config(config);  // Prepare to extract data from the images
    imageExtractionConfig.cleaner = [];
    imageExtractionConfig.output.formats = {
      json: true,
      text: false,
      markdown: false,
      csv: false,
      pdf: false,
    };
    const imageCleaner: Cleaner = new Cleaner(imageExtractionConfig);
    let orchestrator: Orchestrator;
    if (config.extractor.img === 'tesseract') {
      orchestrator = new Orchestrator(new TesseractExtractor(imageExtractionConfig), imageCleaner);
    } else {
      orchestrator = new Orchestrator(new AbbyyTools(imageExtractionConfig), imageCleaner);
    }

    pageObj.figure.forEach(fig => {
      const newImageElements: Image[] = interpretImages(fig, imagsLocation, pageBBox.height);
      elements = [...elements, ...newImageElements];         // Add the new image elmenets

      imgOCRPromises.concat(
        newImageElements.map(
          (imgElement: Image) => orchestrator.run(imgElement.src),
        ),
      );
    });
  }

  // resolve all the OCR promises
  return await Promise.all(imgOCRPromises)
  .then((docs: Document[]) => {
    const newElements: Element[] = [].concat(...docs.map((doc: Document) => doc.getAllElements()));
    return new Page(parseFloat(pageObj._attr.id), elements.concat(newElements), pageBBox);
  });
}

// Pdfminer's bboxes are of the format: x0, y0, x1, y1. Our BoundingBox dims are as: left, top, width, height
function getBoundingBox(
  bbox: string,
  splitter: string = ',',
  pageHeight: number = 0,
  scalingFactor: number = 1,
): BoundingBox {
  const values: number[] = bbox.split(splitter).map(v => parseFloat(v) * scalingFactor);
  const width: number = Math.abs(values[2] - values[0]); // right - left = width
  const height: number = Math.abs(values[1] - values[3]); // top - bottom = height
  const left: number = values[0];
  const top: number = Math.abs(pageHeight - values[1]) - height; // invert x direction (pdfminer's (0,0)
  // is on the bottom left)
  return new BoundingBox(left, top, width, height);
}

function getMostCommonFont(theFonts: Font[]): Font {
  const fonts: Font[] = theFonts.reduce((a, b) => a.concat(b), []);

  const baskets: Font[][] = [];

  fonts.forEach((font: Font) => {
    let basketFound: boolean = false;
    baskets.forEach((basket: Font[]) => {
      if (basket.length > 0 && basket[0].isEqual(font)) {
        basket.push(font);
        basketFound = true;
      }
    });

    if (!basketFound) {
      baskets.push([font]);
    }
  });

  baskets.sort((a, b) => {
    return b.length - a.length;
  });

  if (baskets.length > 0 && baskets[0].length > 0) {
    return baskets[0][0];
  } else {
    return Font.undefinedFont;
  }
}

/**
 * Fetches the character a particular pdfminer's textual output represents
 * TODO: This placeholder will accommodate the solution at https://github.com/aarohijohal/pdfminer.six/issues/1 ...
 * TODO: ... For now, it returns a '?' when a (cid:) is encountered
 * @param character the character value outputted by pdfminer
 * @param font the font associated with the character  -- TODO to be taken into consideration here
 */
function getValidCharacter(character: string): string {
  return RegExp(/\(cid:/gm).test(character) ? '?' : character;
}

function interpretImages(
  fig: PdfminerFigure,
  imagsLocation: string,
  pageHeight: number,
  scalingFactor: number = 1,
): Image[] {
  const resultantImages: Image[] = fig.image.map(
    img =>
      new Image(
        getBoundingBox(fig._attr.bbox, ',', pageHeight, scalingFactor),
        path.join(imagsLocation, img._attr.src),
      ),
  );
  return resultantImages;
}
function breakLineIntoWords(
  line: PdfminerTextline,
  wordSeparator: string = ' ',
  pageHeight: number,
  scalingFactor: number = 1,
): Word[] {
  const notAllowedChars = ['\u200B']; // &#8203 Zero Width Space
  const words: Word[] = [];
  const fakeSpaces = thereAreFakeSpaces(line);
  const chars: Character[] = line.text
    .filter(char => !notAllowedChars.includes(char._) && !isFakeChar(char, fakeSpaces))
    .map(char => {
      if (char._ === undefined) {
        return undefined;
      } else {
        const font: Font = new Font(char._attr.font, parseFloat(char._attr.size), {
          weight: RegExp(/bold/gim).test(char._attr.font) ? 'bold' : 'medium',
          isItalic: RegExp(/italic/gim).test(char._attr.font) ? true : false,
          isUnderline: RegExp(/underline/gim).test(char._attr.font) ? true : false,
          color: ncolourToHex(char._attr.ncolour),
        });
        const charContent: string = getValidCharacter(char._);
        return new Character(
          getBoundingBox(char._attr.bbox, ',', pageHeight, scalingFactor),
          charContent,
          font,
        );
      }
    });
  if (chars[0] === undefined || chars[0].content === wordSeparator) {
    chars.splice(0, 1);
  }
  if (chars[chars.length - 1] === undefined || chars[chars.length - 1].content === wordSeparator) {
    chars.splice(chars.length - 1, chars.length);
  }

  if (chars.length === 0 || (chars.length === 1 && chars[0] === undefined)) {
    return words;
  }

  if (
    chars
      .filter(c => c !== undefined)
      .map(c => c.content.length)
      .filter(l => l > 1).length > 0
  ) {
    logger.debug(`pdfminer returned some characters of size > 1`);
  }

  const sepLocs: number[] = chars
    .map((c, i) => {
      if (c === undefined) {
        return i;
      } else {
        return undefined;
      }
    })
    .filter(l => l !== undefined)
    .filter(l => l !== 0)
    .filter(l => l !== chars.length);

  let charSelection: Character[] = [];
  if (sepLocs.length === 0) {
    charSelection = chars.filter(c => c !== undefined);
    words.push(
      new Word(
        BoundingBox.merge(charSelection.map(c => c.box)),
        charSelection,
        getMostCommonFont(charSelection.map(c => c.font)),
      ),
    );
  } else {
    charSelection = chars.slice(0, sepLocs[0]).filter(c => c !== undefined);
    if (charSelection.length > 0) {
      words.push(
        new Word(
          BoundingBox.merge(charSelection.map(c => c.box)),
          charSelection,
          getMostCommonFont(charSelection.map(c => c.font)),
        ),
      );
    }
    for (let i = 0; i !== sepLocs.length; ++i) {
      let from: number;
      let to: number;
      from = sepLocs[i] + 1;
      if (i !== sepLocs.length - 1) {
        to = sepLocs[i + 1];
      } else {
        to = chars.length;
      }
      charSelection = chars.slice(from, to).filter(c => c !== undefined);
      if (charSelection.length > 0) {
        words.push(
          new Word(
            BoundingBox.merge(charSelection.map(c => c.box)),
            charSelection,
            getMostCommonFont(charSelection.map(c => c.font)),
          ),
        );
      }
    }
  }
  return words;
}

function thereAreFakeSpaces(lines: PdfminerTextline): boolean {
  // Will remove all <text> </text> only if in line we found
  // <text> </text> followed by empty <text> but with attributes
  // <text font="W" bbox="W" colourspace="X" ncolour="Y" size="Z"> </text>
  const emptyWithAttr = lines.text
    .map((word, index) => {
      return { text: word, pos: index };
    })
    .filter(word => word.text._ === undefined && word.text._attr !== undefined)
    .map(word => word.pos);
  const emptyWithNoAttr = lines.text
    .map((word, index) => {
      return { text: word, pos: index };
    })
    .filter(word => word.text._ === undefined && word.text._attr === undefined)
    .map(word => word.pos);

  let fakeSpaces = false;
  emptyWithNoAttr.forEach(pos => {
    if (emptyWithAttr.includes(pos + 1)) {
      fakeSpaces = true;
    }
  });
  return fakeSpaces;
}

function isFakeChar(word: PdfminerText, fakeSpacesInLine: boolean): boolean {
  if (fakeSpacesInLine && word._ === undefined && word._attr === undefined) {
    return true;
  }

  return false;
}

function ncolourToHex(color: string) {
  const rgbToHex = (r, g, b) =>
    '#' +
    [r, g, b]
      .map(x => {
        const hex = Math.ceil(x * 255).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      })
      .join('');

  const rgbColor = color
    .replace('[', '')
    .replace(']', '')
    .split(',');

  return rgbToHex(rgbColor[0], rgbColor[1] || rgbColor[0], rgbColor[2] || rgbColor[0]);
}

/**
 * Repair a pdf using the external mutool utility.
 * Use qpdf to decrcrypt the pdf to avoid errors due to DRMs.
 * @param filePath The absolute filename and path of the pdf file to be repaired.
 */
function repairPdf(filePath: string) {
  const qpdfPath = utils.getCommandLocationOnSystem('qpdf');
  if (qpdfPath) {
    const pdfOutputFile = utils.getTemporaryFile('.pdf');
    const process = spawnSync('qpdf', ['--decrypt', filePath, pdfOutputFile]);

    if (process.status === 0) {
      filePath = pdfOutputFile;
    } else {
      logger.warn('qpdf error:', process.status, process.stdout.toString(), process.stderr.toString());
    }
  }

  return new Promise<string>(resolve => {
    const mutoolPath = utils.getCommandLocationOnSystem('mutool');
    if (!mutoolPath) {
      logger.warn('MuPDF not installed !! Skip clean PDF.');
      resolve(filePath);
    } else {
      const pdfOutputFile = utils.getTemporaryFile('.pdf');
      const pdfFixer = spawn('mutool', ['clean', filePath, pdfOutputFile]);
      pdfFixer.on('close', () => {
        // Check that the file is correctly written on the file system
        fs.fsyncSync(fs.openSync(filePath, 'r+'));
        resolve(pdfOutputFile);
      });
    }
  });
}
