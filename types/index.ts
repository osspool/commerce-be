// ==================== Product Types ====================

export interface ProductImage {
    url: string;
    alt: string;
  }
  
  export interface VariationOption {
    value: string;
    priceModifier: number;
    quantity: number;
  }
  
  export interface ProductVariation {
    name: string;
    options: VariationOption[];
  }
  
  export interface Product {
    id: string;
    name: string;
    slug: string;
    description: string;
    details?: string;
    materials?: string;
    features?: string[];
    care?: string[];
    basePrice: number;
    originalPrice?: number;
    category: string;
    parentCategory: string;
    images: ProductImage[];
    variations: ProductVariation[];
    isNew?: boolean;
    isBestSeller?: boolean;
    averageRating?: number;
    reviewCount?: number;
  }
  
  // ==================== Cart Types ====================
  
  export interface CartVariation {
    name: string;
    option: {
      value: string;
      priceModifier: number;
    };
  }
  
  export interface CartItem {
    productId: string;
    name: string;
    image: string;
    basePrice: number;
    quantity: number;
    variations: CartVariation[];
  }
  
  // ==================== Order Types ====================
  
  export interface DeliveryAddress {
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state?: string;
    postalCode?: string;
    phone: string;
  }
  
  export interface DeliveryOption {
    id: string;
    label: string;
    price: number;
    days: string;
  }
  
  // ==================== Payment Types ====================
  
  export type PaymentGateway = "manual" | "sslcommerz" | "stripe";
  
  export type ManualPaymentMethod = "cash" | "bkash" | "nagad" | "rocket" | "bank";
  
  export interface WalletDetails {
    walletNumber: string;
    walletName: string;
    note?: string;
  }
  
  export interface BankDetails {
    bankName: string;
    accountNumber: string;
    accountName: string;
    branchName?: string;
    routingNumber?: string;
    swiftCode?: string;
    note?: string;
  }
  
  export interface PlatformPaymentConfig {
    cash?: { enabled: boolean };
    bkash?: WalletDetails;
    nagad?: WalletDetails;
    rocket?: WalletDetails;
    bank?: BankDetails;
  }
  
  export interface PaymentData {
    method: ManualPaymentMethod;
    reference?: string;
    senderPhone?: string;
    paymentDetails?: {
      walletNumber?: string;
      walletType?: "personal" | "merchant";
      bankName?: string;
      accountNumber?: string;
      accountName?: string;
      proofUrl?: string;
    };
    notes?: string;
  }
  
  // ==================== Review Types ====================
  
  export interface ReviewUser {
    id: string;
    name: string;
    avatar?: string;
  }
  
  export interface Review {
    id: string;
    user: ReviewUser;
    productId: string;
    rating: number;
    comment: string;
    createdAt: string;
    helpful?: number;
    images?: string[];
  }
  
  // ==================== Coupon Types ====================
  
  export interface Coupon {
    code: string;
    type: "percentage" | "fixed";
    value: number;
    minPurchase: number;
    maxDiscount?: number;
    expiryDate: string;
    active: boolean;
  }
  
  // ==================== Filter Types ====================
  
  export interface ProductFilters {
    category?: string;
    parentCategory?: string;
    sizes: string[];
    colors: string[];
    priceRange?: [number, number];
    sortBy: SortOption;
  }
  
  export type SortOption = "newest" | "price-asc" | "price-desc" | "best-selling";
  
  export interface SortOptionConfig {
    label: string;
    value: SortOption;
  }
  
  // ==================== CMS Types ====================
  
  export interface CMSMetadata {
    title: string;
    description: string;
    keywords: string[];
    ogImage?: string;
  }
  
  export interface CMSPage<T = Record<string, any>> {
    name: string;
    slug: string;
    status: "draft" | "published" | "archived";
    content: T;
    metadata: CMSMetadata;
    publishedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
  }
  