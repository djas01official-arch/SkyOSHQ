ALTER TYPE "KnowledgeAttachmentProcessingStatus" ADD VALUE 'QUEUED' AFTER 'UPLOADED';
ALTER TYPE "KnowledgeAttachmentProcessingStatus" ADD VALUE 'CHUNKING' AFTER 'PROCESSED';
ALTER TYPE "KnowledgeAttachmentProcessingStatus" ADD VALUE 'EMBEDDING' AFTER 'CHUNKING';
ALTER TYPE "KnowledgeAttachmentProcessingStatus" ADD VALUE 'READY' AFTER 'EMBEDDING';
