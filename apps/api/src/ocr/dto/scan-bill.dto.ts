import { IsIn, IsOptional } from 'class-validator';

export const OCR_DOCUMENT_TYPES = ['BILL', 'INVOICE', 'RECEIPT', 'HANDWRITTEN'] as const;
export type OcrDocumentType = (typeof OCR_DOCUMENT_TYPES)[number];

/** Multipart body of `POST /ocr/scan-bill`: the image travels in the `file` part. */
export class ScanBillDto {
  @IsOptional()
  @IsIn(OCR_DOCUMENT_TYPES)
  documentType?: OcrDocumentType;
}
